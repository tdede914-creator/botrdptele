const axios = require('axios');
const crypto = require('crypto');
const db = require('../config/database');

const PAKASIR_BASE_URL = (process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com').replace(/\/$/, '');

function getActiveGateway() {
  const raw = String(process.env.PAYMENT_GATEWAY || 'dompetx').toLowerCase();
  if (raw === 'pakasir') return 'pakasir';
  if (raw === 'orderkuota') return 'orderkuota';
  if (raw === 'valqenix') return 'valqenix';
  return 'dompetx';
}

function getPakasirConfig() {
  return {
    slug: (process.env.PAKASIR_SLUG || process.env.PAKASIR_PROJECT || '').trim(),
    apiKey: (process.env.PAKASIR_API_KEY || '').trim(),
    method: (process.env.PAKASIR_METHOD || 'qris').trim() || 'qris'
  };
}

async function findAmountForTransaction(transactionId) {
  if (!transactionId) return null;

  const lookups = [
    ['pending_payments', 'transaction_id'],
    ['pending_payments', 'unique_code'],
    ['shop_pending_payments', 'transaction_id'],
    ['shop_pending_payments', 'unique_code'],
    ['renter_pending_payments', 'transaction_id'],
    ['renter_pending_payments', 'unique_code']
  ];

  for (const [table, column] of lookups) {
    try {
      const row = await db.get(`SELECT amount FROM ${table} WHERE ${column} = ? ORDER BY created_at DESC LIMIT 1`, [transactionId]);
      if (row && Number(row.amount) > 0) return Number(row.amount);
    } catch (_) {}
  }

  return null;
}

function extractError(error) {
  const data = error?.response?.data;
  if (typeof data === 'string') return data;
  return data?.message || data?.error || data?.errors?.[0]?.message || error?.message || 'Terjadi kesalahan payment gateway';
}

async function createPakasirPayment(reffId, amount) {
  const { slug, apiKey, method } = getPakasirConfig();

  if (!slug) return { success: false, error: 'PAKASIR_SLUG belum diisi di .env' };
  if (!apiKey) return { success: false, error: 'PAKASIR_API_KEY belum diisi di .env' };

  const payload = {
    project: slug,
    order_id: reffId,
    amount: Number(amount),
    api_key: apiKey
  };

  try {
    const res = await axios.post(`${PAKASIR_BASE_URL}/api/transactioncreate/${encodeURIComponent(method)}`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });

    const payment = res.data?.payment || res.data?.transaction || res.data?.data || res.data || {};
    const orderId = payment.order_id || payment.reference || reffId;
    const total = Number(payment.amount || amount);

    const paymentUrl =
      payment.payment_url ||
      payment.paymentUrl ||
      payment.checkout_url ||
      `${PAKASIR_BASE_URL}/pay/${encodeURIComponent(slug)}/${total}?order_id=${encodeURIComponent(orderId)}${method === 'qris' ? '&qris_only=1' : ''}`;

    return {
      success: true,
      data: {
        id: orderId,
        reff_id: orderId,
        nominal: total,
        fee: Number(payment.fee || 0),
        tambahan: 0,
        get_balance: Number(payment.amount || amount),
        qr_string: payment.payment_number || payment.qr_string || payment.qris_string || payment.qr_payload || payment.qrCode || payment.qr_code || null,
        qr_image: payment.qr_image || payment.qr_url || payment.qris_url || null,
        payment_url: paymentUrl,
        status: payment.status || 'pending',
        created_at: payment.created_at || new Date().toISOString(),
        expired_at: payment.expired_at || null,
        payment_gateway: 'pakasir',
        raw: res.data
      }
    };
  } catch (error) {
    console.error('Pakasir create payment error:', error?.response?.data || error.message);
    return { success: false, error: extractError(error) };
  }
}

async function checkPakasirStatus(transactionId, amount = null) {
  const { slug, apiKey } = getPakasirConfig();

  if (!slug) return { success: false, error: 'PAKASIR_SLUG belum diisi di .env' };
  if (!apiKey) return { success: false, error: 'PAKASIR_API_KEY belum diisi di .env' };
  if (!transactionId) return { success: false, error: 'transactionId kosong' };

  const trxAmount = Number(amount || await findAmountForTransaction(transactionId));
  if (!trxAmount) return { success: false, error: 'Amount transaksi Pakasir tidak ditemukan' };

  try {
    const url =
      `${PAKASIR_BASE_URL}/api/transactiondetail` +
      `?project=${encodeURIComponent(slug)}` +
      `&amount=${encodeURIComponent(trxAmount)}` +
      `&order_id=${encodeURIComponent(transactionId)}` +
      `&api_key=${encodeURIComponent(apiKey)}`;

    const res = await axios.get(url, { timeout: 15000 });
    const trx = res.data?.transaction || res.data?.payment || res.data?.data || res.data || {};

    return {
      success: true,
      data: {
        id: trx.order_id || transactionId,
        reference: trx.order_id || transactionId,
        status: trx.status || 'unknown',
        amount: Number(trx.amount || trxAmount),
        fee: Number(trx.fee || 0),
        get_balance: Number(trx.amount || trxAmount),
        qr_image: trx.qr_image || trx.qr_url || null,
        qr_string: trx.payment_number || trx.qr_string || trx.qris_string || null,
        paid_at: trx.completed_at || trx.paid_at || trx.updated_at || null,
        expired_at: trx.expired_at || null,
        payment_gateway: 'pakasir',
        raw: res.data
      }
    };
  } catch (error) {
    console.error('Pakasir status error:', error?.response?.data || error.message);
    return { success: false, error: extractError(error) };
  }
}

// ============================================================
// VALQENIX — QRIS payment gateway (https://app.valqenix.com)
// Endpoint & field-name dibuat dapat diatur via .env karena spesifik doc
// masing-masing akun. Default mengikuti pola umum gateway QRIS; sesuaikan
// VALQENIX_* di .env sesuai dokumentasi Anda bila berbeda.
// ============================================================
function getValqenixConfig() {
  return {
    apiKey: (process.env.VALQENIX_API_KEY || '').trim(),
    // Sesuai doc: base https://app.valqenix.com/api/v1, auth header X-API-Key (tanpa prefix).
    baseUrl: (process.env.VALQENIX_BASE_URL || 'https://app.valqenix.com/api/v1').replace(/\/$/, ''),
    createPath: (process.env.VALQENIX_CREATE_PATH || '/payments').trim(),
    statusPath: (process.env.VALQENIX_STATUS_PATH || '/payments/{id}').trim(),
    cancelPath: (process.env.VALQENIX_CANCEL_PATH || '/payments/{id}/cancel').trim(),
    authHeader: (process.env.VALQENIX_AUTH_HEADER || 'X-API-Key').trim(),
    authPrefix: process.env.VALQENIX_AUTH_PREFIX !== undefined ? process.env.VALQENIX_AUTH_PREFIX : ''
  };
}

function valqenixHeaders(cfg) {
  return { 'Content-Type': 'application/json', Accept: 'application/json', [cfg.authHeader]: `${cfg.authPrefix}${cfg.apiKey}` };
}

// Ambil nilai pertama yang ada dari beberapa kemungkinan nama field.
function vpick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (k.includes('.')) {
      const v = k.split('.').reduce((a, p) => (a && a[p] !== undefined ? a[p] : undefined), obj);
      if (v !== undefined && v !== null && v !== '') return v;
    } else if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      return obj[k];
    }
  }
  return undefined;
}

// Create Payment: POST /api/v1/payments { amount, note } -> data { reference,
// requested_amount, admin_fee, total_pay, payment_link, status }.
// Catatan: Valqenix mengembalikan payment_link (halaman QRIS hosted), bukan qr_string.
// Kita simpan payment_url = payment_link; qr_string/qr_image dipakai bila ada.
async function createValqenixPayment(reffId, amount) {
  const cfg = getValqenixConfig();
  if (!cfg.apiKey) return { success: false, error: 'VALQENIX_API_KEY belum diisi di .env' };
  const payload = { amount: Number(amount), note: `Order ${reffId}` };
  try {
    const res = await axios.post(`${cfg.baseUrl}${cfg.createPath}`, payload, { headers: valqenixHeaders(cfg), timeout: 30000 });
    const root = res.data || {};
    const d = root.data || root;
    const reference = vpick(d, ['reference', 'id', 'reference_id', 'invoice_id']) || reffId;
    const paymentLink = vpick(d, ['payment_link', 'payment_url', 'checkout_url', 'url']);
    const qrString = vpick(d, ['qr_string', 'qris_string', 'qris', 'qr_content', 'qr_payload', 'qrData.qrString']);
    const qrImage = vpick(d, ['qr_image', 'qris_image', 'qr_url', 'qrData.qrImage', 'qr_image_url']);
    if (!paymentLink && !qrString && !qrImage) {
      return { success: false, error: 'Respon Valqenix tidak berisi payment_link/QR. Cek VALQENIX_CREATE_PATH/API key.', raw: root };
    }
    return {
      success: true,
      data: {
        id: reference,
        reff_id: reffId,
        nominal: Number(amount),
        fee: Number(vpick(d, ['admin_fee', 'fee']) || 0),
        total_pay: Number(vpick(d, ['total_pay', 'total_amount']) || amount),
        tambahan: 0,
        // Deposit: user menerima saldo sebesar `amount` yang diminta (fee ditanggung pembayar).
        get_balance: Number(amount),
        qr_string: qrString || null,
        qr_image: qrImage || null,
        payment_url: paymentLink || null,
        status: vpick(d, ['status']) || 'pending',
        created_at: vpick(d, ['created_at']) || new Date().toISOString(),
        expired_at: vpick(d, ['expired_at', 'expires_at', 'expiry_time']) || null,
        payment_gateway: 'valqenix',
        raw: root
      }
    };
  } catch (error) {
    console.error('Valqenix create payment error:', error?.response?.data || error.message);
    return { success: false, error: extractError(error) };
  }
}

// Check Status: GET /api/v1/payments/:reference -> data.status (pending|paid|expired|cancelled)
async function checkValqenixStatus(transactionId, amount = null) {
  const cfg = getValqenixConfig();
  if (!cfg.apiKey) return { success: false, error: 'VALQENIX_API_KEY belum diisi di .env' };
  if (!transactionId) return { success: false, error: 'transactionId kosong' };
  try {
    const path = cfg.statusPath.includes('{id}') ? cfg.statusPath.replace('{id}', encodeURIComponent(transactionId)) : `${cfg.statusPath}/${encodeURIComponent(transactionId)}`;
    const res = await axios.get(`${cfg.baseUrl}${path}`, { headers: valqenixHeaders(cfg), timeout: 15000 });
    const root = res.data || {};
    const d = root.data || root;
    return {
      success: true,
      data: {
        id: vpick(d, ['reference', 'id']) || transactionId,
        reference: transactionId,
        status: vpick(d, ['status', 'transaction_status', 'payment_status']) || 'unknown',
        amount: Number(vpick(d, ['requested_amount', 'amount', 'total_pay']) || amount || 0),
        get_balance: Number(amount || vpick(d, ['requested_amount', 'amount']) || 0),
        paid_at: vpick(d, ['paid_at', 'settled_at', 'updated_at']) || null,
        expired_at: vpick(d, ['expired_at', 'expires_at']) || null,
        payment_gateway: 'valqenix',
        raw: root
      }
    };
  } catch (error) {
    console.error('Valqenix status error:', error?.response?.data || error.message);
    return { success: false, error: extractError(error) };
  }
}

// Cancel: POST /api/v1/payments/:reference/cancel (hanya jika masih pending)
async function cancelValqenixPayment(transactionId) {
  const cfg = getValqenixConfig();
  if (!cfg.apiKey || !transactionId) return { success: false, skipped: true };
  try {
    const path = cfg.cancelPath.includes('{id}') ? cfg.cancelPath.replace('{id}', encodeURIComponent(transactionId)) : `/payments/${encodeURIComponent(transactionId)}/cancel`;
    const res = await axios.post(`${cfg.baseUrl}${path}`, {}, { headers: valqenixHeaders(cfg), timeout: 15000 });
    return { success: !!(res.data && (res.data.success !== false)), raw: res.data };
  } catch (error) {
    return { success: false, error: extractError(error) };
  }
}

// Verifikasi tanda tangan webhook Valqenix.
// Header: X-Valqenix-Signature: v1=HMAC_SHA256(`${timestamp}.${rawBody}`), X-Valqenix-Timestamp.
function verifyValqenixWebhook(rawBody, signatureHeader, timestamp, secret) {
  secret = secret || process.env.VALQENIX_WEBHOOK_SECRET || '';
  if (!secret || !signatureHeader || !timestamp) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const provided = String(signatureHeader).replace(/^v1=/, '').trim();
  try {
    const a = Buffer.from(provided); const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

module.exports = {
  getActiveGateway,
  getPakasirConfig,
  createPakasirPayment,
  checkPakasirStatus,
  getValqenixConfig,
  createValqenixPayment,
  checkValqenixStatus,
  cancelValqenixPayment,
  verifyValqenixWebhook
};
