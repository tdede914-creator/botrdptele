/**
 * Binance REST API client for Personal API keys (spot account).
 *
 * Only exposes the two endpoints the bot needs for crypto payment
 * verification:
 *   1. GET /sapi/v1/capital/deposit/hisrec   — for USDT BEP20 verification
 *   2. GET /sapi/v1/pay/transactions          — for Binance Pay order verification
 *
 * The bot NEVER calls withdrawal or trading endpoints. The API key should be
 * created with the following permissions ONLY:
 *   ✅ Enable Reading
 *   ❌ Enable Withdrawals  (do NOT enable — security risk)
 *   ❌ Enable Spot Trading (not needed)
 *
 * Configuration is read from environment variables:
 *   BINANCE_API_KEY     — your Binance API key
 *   BINANCE_API_SECRET  — the corresponding API secret
 *   BINANCE_BASE_URL    — optional, defaults to https://api.binance.com
 */

const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
const RECV_WINDOW = 10_000; // ms, max 60_000 per Binance docs

function getApiCredentials() {
  const apiKey = (process.env.BINANCE_API_KEY || '').trim();
  const apiSecret = (process.env.BINANCE_API_SECRET || '').trim();
  return { apiKey, apiSecret };
}

function isConfigured() {
  const { apiKey, apiSecret } = getApiCredentials();
  return !!apiKey && !!apiSecret;
}

/**
 * Build a signed query string. Order matters: Binance requires the
 * signature to be computed over the exact query string that is sent.
 */
function buildSignedQuery(params, apiSecret) {
  const qsParts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qsParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  qsParts.push(`timestamp=${Date.now()}`);
  qsParts.push(`recvWindow=${RECV_WINDOW}`);
  const query = qsParts.join('&');
  const signature = crypto.createHmac('sha256', apiSecret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

/**
 * Perform a signed GET request. Returns { ok, data, error, status }.
 * We intentionally do NOT throw so callers can branch on `ok` cleanly.
 */
async function signedGet(pathname, params = {}) {
  const { apiKey, apiSecret } = getApiCredentials();
  if (!apiKey || !apiSecret) {
    return { ok: false, error: 'BINANCE_API_KEY / BINANCE_API_SECRET belum diset di environment.' };
  }
  const url = `${BASE_URL}${pathname}?${buildSignedQuery(params, apiSecret)}`;
  try {
    const res = await axios.get(url, {
      headers: { 'X-MBX-APIKEY': apiKey },
      timeout: 20_000,
      validateStatus: () => true // Handle status manually below.
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, data: res.data, status: res.status };
    }
    // Binance error body shape: { code: -1234, msg: "..." }
    const msg = res.data?.msg || res.data?.message || `HTTP ${res.status}`;
    return { ok: false, error: msg, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Fetch deposit history for a given coin (default USDT). Optionally filter
 * by txId or network. Returns array of deposits normalized to a stable shape.
 *
 * Binance returns each deposit with fields:
 *   { amount, coin, network, status, address, txId, insertTime, confirmTimes, ... }
 * status: 0 = pending, 6 = credited but cannot withdraw, 1 = success
 */
async function getDepositHistory({ coin = 'USDT', network = null, txId = null, startTime = null, endTime = null, limit = 100 } = {}) {
  const params = { coin };
  if (network) params.network = network;
  if (txId) params.txId = txId;
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  if (limit) params.limit = Math.min(Math.max(1, Number(limit) || 100), 1000);

  const res = await signedGet('/sapi/v1/capital/deposit/hisrec', params);
  if (!res.ok) return { ok: false, error: res.error, status: res.status };

  const rows = Array.isArray(res.data) ? res.data : [];
  const normalized = rows.map(r => ({
    amount: Number(r.amount),
    coin: String(r.coin || '').toUpperCase(),
    network: String(r.network || '').toUpperCase(),
    address: r.address || null,
    addressTag: r.addressTag || null,
    txId: r.txId || null,
    insertTime: Number(r.insertTime || 0),
    status: Number(r.status),
    statusLabel: mapDepositStatus(r.status),
    confirmTimes: r.confirmTimes || null,
    raw: r
  }));

  return { ok: true, deposits: normalized };
}

function mapDepositStatus(code) {
  const n = Number(code);
  if (n === 0) return 'pending';
  if (n === 1) return 'success';
  if (n === 6) return 'credited_no_withdraw'; // Binance considers this a success for our purpose
  if (n === 7) return 'wrong_deposit';
  if (n === 8) return 'waiting_user_confirm';
  return `unknown_${n}`;
}

/**
 * Fetch Binance Pay transaction history. Used to verify internal Binance
 * transfers by Order ID. Returns array of transactions.
 *
 * Response body shape:
 *   { code: "000000", message: "success", data: [ {transactionId, amount, currency, transactionTime, ... } ] }
 */
async function getPayTransactions({ startTime = null, endTime = null, limit = 100 } = {}) {
  const params = {};
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  if (limit) params.limit = Math.min(Math.max(1, Number(limit) || 100), 100);

  const res = await signedGet('/sapi/v1/pay/transactions', params);
  if (!res.ok) return { ok: false, error: res.error, status: res.status };

  if (String(res.data?.code || '') !== '000000') {
    return { ok: false, error: res.data?.message || 'Binance Pay API returned non-success code', code: res.data?.code };
  }

  const rows = Array.isArray(res.data.data) ? res.data.data : [];
  const normalized = rows.map(r => ({
    transactionId: r.transactionId || null,
    orderType: r.orderType || null,
    transactionTime: Number(r.transactionTime || 0),
    amount: Number(r.amount),
    currency: String(r.currency || '').toUpperCase(),
    walletType: r.walletType || null,
    payerInfo: r.payerInfo || null,
    raw: r
  }));

  return { ok: true, transactions: normalized };
}

/**
 * Convenience: find one deposit that matches a txId. Falls back to case-
 * insensitive comparison and accepts optional network filter.
 * Returns { ok, found, deposit, error }.
 */
async function findDepositByTxId(txId, { coin = 'USDT', network = null } = {}) {
  if (!txId || typeof txId !== 'string') {
    return { ok: false, error: 'TX-ID kosong / tidak valid.' };
  }
  const wanted = txId.trim().toLowerCase();
  const res = await getDepositHistory({ coin, network, txId, limit: 20 });
  if (!res.ok) return { ok: false, error: res.error };

  // Binance sometimes ignores the txId filter — search client-side too.
  const match = res.deposits.find(d => String(d.txId || '').toLowerCase() === wanted);
  if (!match) {
    // Retry without txId filter (some legacy deposit records don't index txId)
    const wider = await getDepositHistory({ coin, network, limit: 100 });
    if (wider.ok) {
      const alt = wider.deposits.find(d => String(d.txId || '').toLowerCase() === wanted);
      if (alt) return { ok: true, found: true, deposit: alt };
    }
    return { ok: true, found: false };
  }
  return { ok: true, found: true, deposit: match };
}

/**
 * Convenience: find one Binance Pay transaction that matches an Order ID.
 * The Binance Pay API doesn't accept a filter by transactionId in the
 * request, so we page recent transactions and match locally.
 */
async function findPayTransactionByOrderId(orderId, { lookbackDays = 7 } = {}) {
  if (!orderId || typeof orderId !== 'string') {
    return { ok: false, error: 'Order ID kosong / tidak valid.' };
  }
  const wanted = orderId.trim();
  const endTime = Date.now();
  const startTime = endTime - Math.max(1, Number(lookbackDays) || 7) * 86_400_000;
  const res = await getPayTransactions({ startTime, endTime, limit: 100 });
  if (!res.ok) return { ok: false, error: res.error };

  const match = res.transactions.find(t => String(t.transactionId || '').trim() === wanted);
  if (!match) return { ok: true, found: false };
  return { ok: true, found: true, transaction: match };
}

module.exports = {
  isConfigured,
  getDepositHistory,
  getPayTransactions,
  findDepositByTxId,
  findPayTransactionByOrderId,
  // Exported for tests / diagnostic use; not intended for other modules
  _internal: { buildSignedQuery, signedGet }
};
