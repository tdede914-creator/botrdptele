const axios = require('axios');
const db = require('../config/database');

const PAKASIR_BASE_URL = (process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com').replace(/\/$/, '');

function getActiveGateway() {
  const raw = String(process.env.PAYMENT_GATEWAY || 'dompetx').toLowerCase();
  if (raw === 'pakasir') return 'pakasir';
  if (raw === 'orderkuota') return 'orderkuota';
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

module.exports = {
  getActiveGateway,
  getPakasirConfig,
  createPakasirPayment,
  checkPakasirStatus
};
