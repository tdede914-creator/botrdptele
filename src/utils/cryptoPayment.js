/**
 * Crypto payment orchestrator.
 *
 * Verifies a user-submitted transaction reference (BEP20 tx hash OR Binance
 * Pay order/transaction id) against the Binance API, converts USDT -> IDR
 * using the current cached rate, applies the fee model, credits the user's
 * balance, and records the deposit in `crypto_deposits`.
 *
 * Public API:
 *   verifyAndCredit({ userId, method, txRef }) ->
 *      {
 *        ok: boolean,            // true if credited
 *        deposit?: {...},        // audit record we inserted
 *        alreadyClaimed?: boolean,
 *        notFound?: boolean,
 *        pendingConfirmation?: boolean,
 *        error?: string
 *      }
 *   getMinDepositUsdt() -> number
 *   getFeeConfig()      -> { percentage, flatIdr, minUsdt }
 *
 * This module NEVER throws — every failure returns an object with a human-
 * readable error string, so the Telegram wizard can just print it.
 *
 * Concurrency / anti-double-spend:
 *   - The `crypto_deposits` table has UNIQUE(method, tx_ref).
 *   - We INSERT a row (status='pending') BEFORE calling addBalance. If the
 *     tx_ref was ever seen we get SQLITE_CONSTRAINT and short-circuit with
 *     `alreadyClaimed: true`. The insert-first pattern makes the race
 *     window essentially zero (two concurrent verify calls for the same
 *     hash: one wins the insert, the other bounces).
 *   - After balance credit succeeds we UPDATE status='success'. A crash
 *     between INSERT and UPDATE leaves a 'pending' row; admin can reconcile
 *     by filtering `status='pending' AND created_at < now-30min`.
 */

const db = require('../config/database');
const binanceApi = require('./binanceApi');
const exchangeRate = require('./exchangeRate');
const adminSettings = require('./adminSettings');
const userManager = require('./userManager');

// Sensible defaults; admin can override via admin_settings table.
const DEFAULT_FEE_PERCENTAGE = 3;      // 3%
const DEFAULT_FEE_FLAT_IDR = 5_000;    // Rp 5.000 minimum
const DEFAULT_MIN_USDT = 1;            // 1 USDT minimum deposit

const METHODS = Object.freeze({
  USDT_BEP20: 'usdt_bep20',
  BINANCE_PAY: 'binance_pay'
});

async function getFeeConfig() {
  return {
    percentage: await adminSettings.getNumber('crypto_fee_percentage', DEFAULT_FEE_PERCENTAGE),
    flatIdr: Math.floor(await adminSettings.getNumber('crypto_fee_flat_idr', DEFAULT_FEE_FLAT_IDR)),
    minUsdt: await adminSettings.getNumber('crypto_min_deposit_usdt', DEFAULT_MIN_USDT)
  };
}

async function getMinDepositUsdt() {
  return adminSettings.getNumber('crypto_min_deposit_usdt', DEFAULT_MIN_USDT);
}

/**
 * Compute the fee for a given IDR amount using the "% or flat, whichever
 * is greater" model. This protects margins on small deposits where 3% would
 * be pennies, while capping % on large deposits at… well, not capping (fee
 * scales up). Admin can set a huge flat to make it effectively flat-only,
 * or 0 flat to make it pure percentage.
 */
function computeFee(amountIdr, feeCfg) {
  const percentageFee = Math.floor(amountIdr * (feeCfg.percentage / 100));
  const flatFee = Math.floor(feeCfg.flatIdr);
  return Math.max(percentageFee, flatFee);
}

/**
 * Query the Binance API for a given method + txRef. Returns a normalized
 * result: { ok, found, amountUsdt, canonicalRef, raw, statusLabel }.
 */
async function verifyOnBinance(method, txRef) {
  if (!binanceApi.isConfigured()) {
    return { ok: false, error: 'Binance API belum dikonfigurasi (BINANCE_API_KEY / BINANCE_API_SECRET kosong).' };
  }

  if (method === METHODS.USDT_BEP20) {
    const res = await binanceApi.findDepositByTxId(txRef, { coin: 'USDT', network: 'BSC' });
    if (!res.ok) return { ok: false, error: res.error };
    if (!res.found) return { ok: true, found: false };

    const d = res.deposit;
    // Consider both "success" and "credited_no_withdraw" as successfully received.
    const isSuccess = d.statusLabel === 'success' || d.statusLabel === 'credited_no_withdraw';
    return {
      ok: true,
      found: true,
      isSuccess,
      isPending: d.statusLabel === 'pending' || d.statusLabel === 'waiting_user_confirm',
      statusLabel: d.statusLabel,
      amountUsdt: Number(d.amount),
      canonicalRef: String(d.txId || txRef).toLowerCase(),
      raw: d.raw
    };
  }

  if (method === METHODS.BINANCE_PAY) {
    const res = await binanceApi.findPayTransactionByOrderId(txRef);
    if (!res.ok) return { ok: false, error: res.error };
    if (!res.found) return { ok: true, found: false };

    const t = res.transaction;
    const amountUsdt = Number(t.amount);
    // Binance Pay transactions in history are already committed.
    // Reject outgoing / negative amounts (e.g. we paid someone else with same id).
    if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
      return { ok: true, found: true, isSuccess: false, statusLabel: 'outgoing_or_invalid', amountUsdt: 0, canonicalRef: String(t.transactionId || txRef), raw: t.raw };
    }
    // We currently only credit stablecoins (USDT); reject other currencies.
    if (t.currency !== 'USDT') {
      return { ok: true, found: true, isSuccess: false, statusLabel: `unsupported_currency_${t.currency}`, amountUsdt: 0, canonicalRef: String(t.transactionId || txRef), raw: t.raw };
    }
    return {
      ok: true,
      found: true,
      isSuccess: true,
      statusLabel: 'success',
      amountUsdt,
      canonicalRef: String(t.transactionId || txRef),
      raw: t.raw
    };
  }

  return { ok: false, error: `Metode tidak dikenali: ${method}` };
}

/**
 * MAIN ENTRY. Never throws. Always returns a plain object.
 */
async function verifyAndCredit({ userId, method, txRef }) {
  // ---- 1. Input validation -----------------------------------------------
  if (!userId || (typeof userId !== 'number' && typeof userId !== 'string')) {
    return { ok: false, error: 'userId tidak valid.' };
  }
  if (method !== METHODS.USDT_BEP20 && method !== METHODS.BINANCE_PAY) {
    return { ok: false, error: `Metode tidak dikenali: ${method}` };
  }
  const trimmedRef = String(txRef || '').trim();
  if (!trimmedRef) {
    return { ok: false, error: 'TX-ID / Order ID kosong.' };
  }

  // ---- 2. Call Binance --------------------------------------------------
  const bin = await verifyOnBinance(method, trimmedRef);
  if (!bin.ok) {
    return { ok: false, error: bin.error };
  }
  if (!bin.found) {
    return {
      ok: false,
      notFound: true,
      error: 'Transaksi tidak ditemukan di akun Binance. Pastikan TX-ID / Order ID benar dan pembayaran sudah masuk. Untuk BEP20 mungkin butuh 1-5 menit setelah konfirmasi block.'
    };
  }
  if (!bin.isSuccess) {
    if (bin.isPending) {
      return {
        ok: false,
        pendingConfirmation: true,
        error: `Transaksi masih menunggu konfirmasi Binance (status: ${bin.statusLabel}). Coba lagi beberapa menit lagi.`
      };
    }
    return { ok: false, error: `Transaksi ditolak Binance (status: ${bin.statusLabel}).` };
  }

  // ---- 3. Minimum deposit gate ------------------------------------------
  const feeCfg = await getFeeConfig();
  if (bin.amountUsdt < feeCfg.minUsdt) {
    return { ok: false, error: `Jumlah terlalu kecil. Minimum deposit ${feeCfg.minUsdt} USDT (kamu kirim ${bin.amountUsdt} USDT).` };
  }

  // ---- 4. USDT -> IDR conversion ---------------------------------------
  const conv = await exchangeRate.convertUsdtToIdr(bin.amountUsdt);
  const grossIdr = conv.idr;
  const feeIdr = computeFee(grossIdr, feeCfg);
  const netIdr = grossIdr - feeIdr;
  if (netIdr <= 0) {
    return { ok: false, error: `Setelah dipotong fee (Rp ${feeIdr.toLocaleString('id-ID')}), sisa deposit ≤ 0. Deposit lebih besar.` };
  }

  // ---- 5. Insert audit row (anti-double-spend lock) --------------------
  const now = Date.now();
  const canonicalRef = bin.canonicalRef;
  let insertedId;
  try {
    const result = await db.run(
      `INSERT INTO crypto_deposits
         (user_id, method, tx_ref, network, amount_usdt, exchange_rate,
          amount_idr, fee_percentage, fee_flat_idr, fee_total_idr, net_credit_idr,
          status, binance_response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        userId,
        method,
        canonicalRef,
        method === METHODS.USDT_BEP20 ? 'BSC' : null,
        bin.amountUsdt,
        conv.rate,
        grossIdr,
        feeCfg.percentage,
        feeCfg.flatIdr,
        feeIdr,
        netIdr,
        JSON.stringify(bin.raw || {}),
        now
      ]
    );
    insertedId = result.id;
  } catch (err) {
    // UNIQUE (method, tx_ref) violation -> already claimed
    if (String(err && err.code) === 'SQLITE_CONSTRAINT' ||
        String(err && err.message || '').toLowerCase().includes('unique')) {
      const existing = await db.get(
        'SELECT id, user_id, status, net_credit_idr, created_at FROM crypto_deposits WHERE method = ? AND tx_ref = ?',
        [method, canonicalRef]
      );
      return { ok: false, alreadyClaimed: true, existing, error: 'Transaksi ini sudah pernah diklaim. Setiap TX-ID hanya bisa digunakan satu kali.' };
    }
    return { ok: false, error: `Gagal menyimpan record deposit: ${err.message || err}` };
  }

  // ---- 6. Credit balance -----------------------------------------------
  try {
    await userManager.addBalance(userId, netIdr);
  } catch (err) {
    // Balance credit failed AFTER we already reserved the tx_ref. Mark row
    // as failed so we don't block re-processing; admin can fix manually.
    try {
      await db.run(
        `UPDATE crypto_deposits
            SET status = 'failed', reject_reason = ?, processed_at = ?
          WHERE id = ?`,
        [`addBalance error: ${err.message || err}`, Date.now(), insertedId]
      );
    } catch (_) { /* best-effort */ }
    return { ok: false, error: `Verifikasi berhasil tapi kredit saldo gagal: ${err.message || err}. Hubungi admin dengan TX-ID.` };
  }

  // ---- 7. Mark row as success ------------------------------------------
  try {
    await db.run(
      `UPDATE crypto_deposits SET status = 'success', processed_at = ? WHERE id = ?`,
      [Date.now(), insertedId]
    );
  } catch (_) { /* record already credited, status update is best-effort */ }

  return {
    ok: true,
    deposit: {
      id: insertedId,
      userId,
      method,
      txRef: canonicalRef,
      amountUsdt: bin.amountUsdt,
      exchangeRate: conv.rate,
      rateSource: conv.source,
      amountIdr: grossIdr,
      feeIdr,
      feePercentage: feeCfg.percentage,
      feeFlatIdr: feeCfg.flatIdr,
      netCreditIdr: netIdr
    }
  };
}

module.exports = {
  verifyAndCredit,
  getFeeConfig,
  getMinDepositUsdt,
  computeFee, // exported for potential preview-before-submit UI
  METHODS,
  DEFAULT_FEE_PERCENTAGE,
  DEFAULT_FEE_FLAT_IDR,
  DEFAULT_MIN_USDT
};
