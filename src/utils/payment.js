const axios = require('axios');
const crypto = require('crypto');

const DOMPETX_BASE_URL = (process.env.DOMPETX_BASE_URL || 'https://api.dompetx.com').replace(/\/$/, '');

function buildBody(payload = {}) {
  return JSON.stringify(payload);
}

function buildHeaders(apiKey, method, bodyString = '{}') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signatureBase = `${timestamp}.${bodyString}`;
  const signature = crypto.createHmac('sha256', apiKey).update(signatureBase).digest('hex');

  return {
    'Content-Type': 'application/json',
    'X-DOMPAY-API-Key': apiKey,
    'X-DOMPAY-Signature': signature,
    'X-DOMPAY-Timestamp': timestamp,
    'Idempotency-Key': `req_${method}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  };
}

function unwrapData(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return payload.data || payload.result || payload.results || payload.payment || payload.transaction || payload;
}

function getByPath(obj, path) {
  if (!obj || typeof obj !== 'object') return undefined;
  return String(path).split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
}

function pick(obj, paths = []) {
  for (const path of paths) {
    const value = path.includes('.') ? getByPath(obj, path) : (obj ? obj[path] : undefined);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeCreateResponse(payload, fallbackReference, requestedAmount) {
  const root = unwrapData(payload) || {};
  const data = root.data && typeof root.data === 'object' ? root.data : root;

  const transactionId = pick(data, [
    'id', 'payment_id', 'transaction_id', 'transactionId', 'providerPaymentId', 'paymentId'
  ]) || fallbackReference;

  const reference = pick(data, [
    'reference', 'reference_id', 'referenceId', 'external_id', 'merchant_reference', 'order_id', 'qrData.refId'
  ]) || fallbackReference;

  const fee = toNumber(pick(data, ['fee', 'admin_fee', 'transaction_fee', 'additionalFee']), 0);
  const nominal = toNumber(pick(data, ['totalAmount', 'total_amount', 'amount', 'gross_amount', 'nominal']), requestedAmount);
  const credited = toNumber(pick(data, ['getBalance', 'net_amount', 'received_amount', 'settlement_amount', 'amount']), requestedAmount);

  return {
    id: transactionId,
    reff_id: reference,
    nominal,
    fee,
    tambahan: toNumber(pick(data, ['additionalFee']), 0),
    get_balance: credited,
    qr_string: pick(data, [
      'qrData.qrString', 'qr_string', 'qr_content', 'qr_payload', 'qris_payload', 'qris_string', 'qrCode', 'qr_code', 'payment_number'
    ]),
    qr_image: pick(data, [
      'qrData.qrImage', 'qr_image', 'qr_url', 'qris_url', 'paymentUrl', 'payment_url', 'qr_image_url', 'checkout_url'
    ]),
    payment_url: pick(data, [
      'paymentUrl', 'payment_url', 'redirectUrl', 'redirect_url', 'checkout_url'
    ]),
    status: pick(data, ['status', 'payment_status', 'transaction_status']) || 'pending',
    created_at: pick(data, ['createdAt', 'created_at', 'transaction_time']) || new Date().toISOString(),
    expired_at: pick(data, ['expiresAt', 'expired_at', 'expires_at', 'expiry_time', 'expiredAt']) || null,
    raw: payload
  };
}

function normalizeStatusResponse(payload) {
  const root = unwrapData(payload) || {};
  const data = root.data && typeof root.data === 'object' ? root.data : root;
  return {
    id: pick(data, ['id', 'payment_id', 'transaction_id', 'transactionId', 'providerPaymentId', 'paymentId']),
    reference: pick(data, ['reference', 'reference_id', 'referenceId', 'external_id', 'order_id', 'qrData.refId']),
    status: pick(data, ['status', 'payment_status', 'transaction_status', 'state']) || 'unknown',
    amount: toNumber(pick(data, ['totalAmount', 'total_amount', 'amount', 'gross_amount', 'nominal']), 0),
    fee: toNumber(pick(data, ['fee', 'admin_fee', 'transaction_fee', 'additionalFee']), 0),
    get_balance: toNumber(pick(data, ['getBalance', 'net_amount', 'received_amount', 'settlement_amount', 'amount']), 0),
    qr_image: pick(data, ['qrData.qrImage', 'qr_image', 'qr_url', 'qris_url', 'paymentUrl', 'payment_url', 'qr_image_url']),
    qr_string: pick(data, ['qrData.qrString', 'qr_string', 'qr_content', 'qr_payload', 'qris_payload', 'qris_string', 'qrCode', 'qr_code']),
    paid_at: pick(data, ['paid_at', 'completed_at', 'updated_at', 'settlement_time']),
    expired_at: pick(data, ['expiresAt', 'expired_at', 'expires_at', 'expiry_time', 'expiredAt']),
    raw: payload
  };
}

function isSuccessEnvelope(payload) {
  if (!payload) return false;
  if (typeof payload !== 'object') return false;
  const statusValue = typeof payload.status === 'string' ? payload.status.toLowerCase() : payload.status;
  const candidates = [payload.success, statusValue, payload.code, payload.id, payload.reference, payload.paymentUrl, payload.qrData];
  return candidates.some((v) => v === true || v === 'success' || v === 'pending' || v === 'paid' || v === 'completed' || v === 200 || !!v);
}

function extractErrorMessage(error) {
  const data = error?.response?.data;
  if (typeof data === 'string') return data;
  return data?.message || data?.error || data?.errors?.[0]?.message || error?.message || 'Terjadi kesalahan jaringan';
}

async function createDompetXPayment(apiKey, reffId, amount) {
  apiKey = (apiKey || '').trim();
  if (!apiKey) {
    return { success: false, error: 'DOMPETX_API_KEY belum diisi' };
  }

  const payload = {
    method: process.env.DOMPETX_PAYMENT_METHOD || 'qris',
    amount: Number(amount),
    currency: process.env.DOMPETX_CURRENCY || 'IDR',
    reference: reffId
  };

  if (process.env.DOMPETX_CALLBACK_URL) payload.callback_url = process.env.DOMPETX_CALLBACK_URL;
  if (process.env.DOMPETX_RETURN_URL) payload.return_url = process.env.DOMPETX_RETURN_URL;
  if (process.env.DOMPETX_CANCEL_URL) payload.cancel_url = process.env.DOMPETX_CANCEL_URL;

  const body = buildBody(payload);
  const headers = buildHeaders(apiKey, 'create', body);

  try {
    const response = await axios.post(`${DOMPETX_BASE_URL}/v1/payments`, body, {
      headers,
      timeout: 30000
    });

    if (!response.data || (!isSuccessEnvelope(response.data) && !unwrapData(response.data))) {
      return {
        success: false,
        error: response.data?.message || response.data?.error || 'Gagal membuat pembayaran DompetX'
      };
    }

    console.log('DompetX raw create payment response:', JSON.stringify(response.data, null, 2));
    return {
      success: true,
      data: normalizeCreateResponse(response.data, reffId, amount)
    };
  } catch (error) {
    console.error('DompetX create payment error status:', error?.response?.status);
    console.error('DompetX create payment error data:', error?.response?.data);
    return { success: false, error: extractErrorMessage(error) };
  }
}

async function checkDompetXStatus(apiKeyOrTransactionId, maybeTransactionId) {
  const apiKey = maybeTransactionId ? (apiKeyOrTransactionId || '').trim() : (process.env.DOMPETX_API_KEY || '').trim();
  const transactionId = maybeTransactionId || apiKeyOrTransactionId;

  if (!apiKey) {
    return { success: false, error: 'DOMPETX_API_KEY belum diisi' };
  }
  if (!transactionId) {
    return { success: false, error: 'transactionId kosong' };
  }

  const emptyBody = '{}';
  const getHeaders = buildHeaders(apiKey, 'status_get', emptyBody);
  const postHeaders = buildHeaders(apiKey, 'status_post', emptyBody);

  const candidates = [
    { method: 'get', url: `${DOMPETX_BASE_URL}/v1/payments/${encodeURIComponent(transactionId)}`, headers: getHeaders },
    { method: 'post', url: `${DOMPETX_BASE_URL}/v1/payments/${encodeURIComponent(transactionId)}`, headers: postHeaders, body: emptyBody },
    { method: 'get', url: `${DOMPETX_BASE_URL}/v1/payments/detail/${encodeURIComponent(transactionId)}`, headers: getHeaders },
    { method: 'post', url: `${DOMPETX_BASE_URL}/v1/payments/detail/${encodeURIComponent(transactionId)}`, headers: postHeaders, body: emptyBody },
    { method: 'get', url: `${DOMPETX_BASE_URL}/v1/payments?reference=${encodeURIComponent(transactionId)}`, headers: getHeaders }
  ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const response = candidate.method === 'post'
        ? await axios.post(candidate.url, candidate.body, { headers: candidate.headers, timeout: 15000 })
        : await axios.get(candidate.url, { headers: candidate.headers, timeout: 15000 });

      if (!response.data) continue;
      console.log('DompetX raw status response:', JSON.stringify(response.data, null, 2));
      return { success: true, data: normalizeStatusResponse(response.data) };
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      if (status && status !== 404) {
        console.error(`DompetX status error response (${candidate.method.toUpperCase()} ${candidate.url}):`, error?.response?.data);
      }
    }
  }

  return { success: false, error: extractErrorMessage(lastError) };
}

function isPaymentStatusSuccessful(status) {
  const raw = typeof status === 'string'
    ? status
    : status?.status || status?.data?.status || '';
  const normalized = String(raw || '').toLowerCase();
  return ['success', 'completed', 'paid', 'settlement', 'capture'].includes(normalized);
}

async function createPayment(apiKey, reffId, amount) {
  const gateway = require('./paymentGateway').getActiveGateway();
  if (gateway === 'pakasir') {
    return require('./paymentGateway').createPakasirPayment(reffId, amount);
  }
  if (gateway === 'orderkuota') {
    return require('./orderkuotaGateway').createOrderkuotaPayment(reffId, amount);
  }
  if (gateway === 'valqenix') {
    return require('./paymentGateway').createValqenixPayment(reffId, amount);
  }
  return createDompetXPayment(apiKey, reffId, amount);
}

async function checkPaymentStatus(apiKeyOrTransactionId, maybeTransactionId, maybeAmount = null) {
  const gateway = require('./paymentGateway').getActiveGateway();
  const transactionId = maybeTransactionId || apiKeyOrTransactionId;
  if (gateway === 'pakasir') {
    return require('./paymentGateway').checkPakasirStatus(transactionId, maybeAmount);
  }
  if (gateway === 'orderkuota') {
    return require('./orderkuotaGateway').checkOrderkuotaStatus(transactionId);
  }
  if (gateway === 'valqenix') {
    return require('./paymentGateway').checkValqenixStatus(transactionId, maybeAmount);
  }
  return checkDompetXStatus(apiKeyOrTransactionId, maybeTransactionId);
}

/**
 * Batalkan invoice di gateway aktif. Dipanggil saat user tap "Batalkan"
 * supaya invoice PENDING tidak menumpuk sebagai sampah di dashboard PG.
 *
 * Aman dipanggil fire-and-forget: kalau gateway tidak support cancel API
 * (Pakasir / DompetX belum), fungsi ini return `{ success: true, skipped: true }`
 * tanpa error.
 */
async function cancelPayment(transactionId) {
  const gateway = require('./paymentGateway').getActiveGateway();
  if (gateway === 'orderkuota') {
    return require('./orderkuotaGateway').cancelOrderkuotaPayment(transactionId);
  }
  if (gateway === 'valqenix') {
    return require('./paymentGateway').cancelValqenixPayment(transactionId);
  }
  // Pakasir & DompetX adapter belum expose cancel endpoint.
  return { success: true, skipped: true, reason: `cancel not implemented for gateway=${gateway}` };
}

module.exports = {
  createPayment,
  checkPaymentStatus,
  cancelPayment,
  isPaymentStatusSuccessful,
  createDompetXPayment,
  checkDompetXStatus
};
