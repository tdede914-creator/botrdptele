/**
 * OrderKuota QRIS adapter.
 *
 * Talks to the self-hosted payment gateway at PG-Donn- (see
 * https://github.com/tdede914-creator/PG-Donn-). That PG polls OrderKuota
 * mutasi + emits a webhook. This module wraps its REST API so the bot can
 * dispatch through it the same way it dispatches to Pakasir / DompetX.
 *
 * Endpoint contract expected on the PG side:
 *   POST {baseUrl}/api/v1/invoices          (X-API-Key: pk_...)
 *     -> { reference, total_amount, qris_string, qris_image, expired_at, pay_url }
 *   GET  {baseUrl}/api/v1/invoices/{ref}    (X-API-Key: pk_...)
 *     -> { status: PENDING | PAID | EXPIRED | CANCELLED, paid_at, ... }
 *   POST {baseUrl}/api/v1/invoices/{ref}/cancel
 *
 * Env:
 *   ORDERKUOTA_PG_URL        Base URL of PG-Donn-, e.g. http://IP:3000
 *   ORDERKUOTA_PG_API_KEY    Public API key (pk_...)
 *   ORDERKUOTA_PG_SECRET     Secret (sk_...) — used to verify webhook HMAC
 *   ORDERKUOTA_CALLBACK_URL  Optional. PG POSTs here on invoice.paid.
 *                            If empty, no webhook is registered and status is
 *                            reconciled purely through polling (checkPaymentStatus).
 */

const axios = require('axios');
const crypto = require('crypto');

function getConfig() {
  return {
    baseUrl: (process.env.ORDERKUOTA_PG_URL || '').replace(/\/$/, ''),
    apiKey: (process.env.ORDERKUOTA_PG_API_KEY || '').trim(),
    secret: (process.env.ORDERKUOTA_PG_SECRET || '').trim(),
    callbackUrl: (process.env.ORDERKUOTA_CALLBACK_URL || '').trim(),
    timeoutMs: Number(process.env.ORDERKUOTA_PG_TIMEOUT_MS || 30000),
  };
}

function extractError(error) {
  const data = error?.response?.data;
  if (typeof data === 'string') return data;
  return (
    data?.message ||
    data?.error ||
    data?.errors?.[0]?.message ||
    error?.message ||
    'Terjadi kesalahan OrderKuota gateway'
  );
}

/**
 * Normalize PG response into the shape depositHandler/paymentStatus expect
 * (same fields as Pakasir/DompetX adapters return).
 */
function normalizeCreateResponse(data, fallbackReference, requestedAmount) {
  const totalAmount = Number(data.total_amount ?? requestedAmount);
  const nominal = Number(data.amount ?? requestedAmount);
  return {
    id: data.reference || fallbackReference,
    reff_id: data.reference || fallbackReference,
    nominal: totalAmount,          // yang harus dibayar (nominal + unique code)
    fee: 0,
    tambahan: Number(data.unique_code || 0),  // "kode unik" dari PG
    get_balance: nominal,          // saldo yang dikredit (tanpa kode unik)
    qr_string: data.qris_string || null,
    qr_image: data.qris_image || null,   // data URL base64 PNG
    payment_url: data.pay_url || null,
    status: (data.status || 'pending').toLowerCase(),
    created_at: new Date().toISOString(),
    expired_at: data.expired_at || null,
    payment_gateway: 'orderkuota',
    raw: data,
  };
}

function normalizeStatusResponse(data) {
  const raw = String(data.status || '').toUpperCase();
  // Map PG status ke lower-case yang dikenal isPaymentStatusSuccessful().
  const statusMap = {
    PAID: 'paid',
    PENDING: 'pending',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled',
  };
  return {
    id: data.reference,
    reference: data.reference,
    status: statusMap[raw] || raw.toLowerCase() || 'unknown',
    amount: Number(data.total_amount ?? 0),
    fee: 0,
    get_balance: Number(data.amount ?? data.total_amount ?? 0),
    qr_image: null,
    qr_string: null,
    paid_at: data.paid_at || null,
    expired_at: data.expired_at || null,
    payment_gateway: 'orderkuota',
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// createOrderkuotaPayment(reffId, amount)
// ---------------------------------------------------------------------------
async function createOrderkuotaPayment(reffId, amount) {
  const { baseUrl, apiKey, callbackUrl, timeoutMs } = getConfig();

  if (!baseUrl) return { success: false, error: 'ORDERKUOTA_PG_URL belum diisi di .env' };
  if (!apiKey) return { success: false, error: 'ORDERKUOTA_PG_API_KEY belum diisi di .env' };

  const body = {
    amount: Number(amount),
    merchant_ref: String(reffId),
    description: `Deposit ${reffId}`,
  };
  if (callbackUrl) body.callback_url = callbackUrl;

  try {
    const res = await axios.post(`${baseUrl}/api/v1/invoices`, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      timeout: timeoutMs,
    });
    return { success: true, data: normalizeCreateResponse(res.data || {}, reffId, amount) };
  } catch (error) {
    console.error('OrderKuota create payment error:', error?.response?.data || error.message);
    return { success: false, error: extractError(error) };
  }
}

// ---------------------------------------------------------------------------
// checkOrderkuotaStatus(reference)
// ---------------------------------------------------------------------------
async function checkOrderkuotaStatus(reference) {
  const { baseUrl, apiKey, timeoutMs } = getConfig();

  if (!baseUrl) return { success: false, error: 'ORDERKUOTA_PG_URL belum diisi' };
  if (!apiKey) return { success: false, error: 'ORDERKUOTA_PG_API_KEY belum diisi' };
  if (!reference) return { success: false, error: 'reference kosong' };

  try {
    const res = await axios.get(
      `${baseUrl}/api/v1/invoices/${encodeURIComponent(reference)}`,
      {
        headers: { 'X-API-Key': apiKey },
        timeout: 15000,
      },
    );
    return { success: true, data: normalizeStatusResponse(res.data || {}) };
  } catch (error) {
    console.error('OrderKuota status error:', error?.response?.data || error.message);
    return { success: false, error: extractError(error) };
  }
}

// ---------------------------------------------------------------------------
// cancelOrderkuotaPayment(reference) - opsional, dipanggil saat user "Batalkan"
// ---------------------------------------------------------------------------
async function cancelOrderkuotaPayment(reference) {
  const { baseUrl, apiKey, timeoutMs } = getConfig();
  if (!baseUrl || !apiKey || !reference) return { success: false, error: 'config/reference invalid' };

  try {
    await axios.post(
      `${baseUrl}/api/v1/invoices/${encodeURIComponent(reference)}/cancel`,
      {},
      {
        headers: { 'X-API-Key': apiKey },
        timeout: 15000,
      },
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: extractError(error) };
  }
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature(bodyString, receivedSignature)
// ---------------------------------------------------------------------------
// PG-Donn- kirim header `X-Signature: HMAC-SHA256(body, apiKey.secret)`.
// Bandingkan dengan constant-time compare untuk mencegah timing attack.
// ---------------------------------------------------------------------------
function verifyWebhookSignature(bodyString, receivedSignature) {
  const { secret } = getConfig();
  if (!secret) {
    console.warn('[orderkuota] ORDERKUOTA_PG_SECRET kosong — signature verify di-skip. TIDAK aman!');
    return true;
  }
  if (!receivedSignature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(String(bodyString))
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(String(receivedSignature), 'hex'),
    );
  } catch (_) {
    return false;
  }
}

module.exports = {
  getConfig,
  createOrderkuotaPayment,
  checkOrderkuotaStatus,
  cancelOrderkuotaPayment,
  verifyWebhookSignature,
  normalizeCreateResponse,
  normalizeStatusResponse,
};
