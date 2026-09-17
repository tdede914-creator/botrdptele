/**
 * Layanan deposit (QRIS) untuk website. Memakai ULANG gateway & pelacak
 * pembayaran yang sama dengan bot, sehingga saldo terkredit lewat jalur yang
 * identik (BalanceManager.updateBalance -> ikut menulis ledger transactions).
 */
const QRCode = require('qrcode');
const { createPayment, checkPaymentStatus } = require('../../src/utils/payment');
const PaymentTracker = require('../../src/utils/paymentTracker');
const BalanceManager = require('../../src/handlers/balanceHandler');
const { getUser } = require('../../src/utils/userManager');

const SUCCESS_STATUSES = ['success', 'settlement', 'capture', 'paid', 'completed'];

async function createDeposit(userId, amount) {
  const uid = String(userId);
  amount = Math.floor(Number(amount));
  if (!amount || amount < 1000) return { ok: false, error: 'Nominal minimal Rp 1.000.' };
  if (amount > 10000000) return { ok: false, error: 'Nominal terlalu besar.' };

  await getUser(uid);
  const uniqueCode = `DEP${Date.now()}${uid}`;
  const payment = await createPayment(process.env.DOMPETX_API_KEY, uniqueCode, amount);
  if (!payment || !payment.success || !payment.data) return { ok: false, error: (payment && payment.error) || 'Gagal membuat pembayaran QRIS.' };
  const d = payment.data;
  if (!d.qr_string && !d.qr_image && !d.payment_url) return { ok: false, error: 'Data pembayaran gateway tidak lengkap.' };

  const expiryTime = d.expired_at ? new Date(d.expired_at).getTime() : (Date.now() + 30 * 60 * 1000);
  await PaymentTracker.addPendingPayment(uid, d.id, d.reff_id, amount, expiryTime);

  let qrDataUrl = d.qr_image || null;
  if (!qrDataUrl && d.qr_string) { try { qrDataUrl = await QRCode.toDataURL(d.qr_string, { width: 320, margin: 1 }); } catch (_) {} }

  // Poller latar belakang: cek status berkala & kredit otomatis saat sukses.
  startPoller(uid, d.id, amount, expiryTime);

  return {
    ok: true,
    transactionId: d.id,
    amount,
    qrString: d.qr_string || null,
    qrImage: qrDataUrl,
    paymentUrl: d.payment_url || null,
    expiresAt: expiryTime
  };
}

/** Cek status sekali + kredit jika sukses (idempoten via pending payment). */
async function checkAndCredit(userId, transactionId, fallbackAmount) {
  const uid = String(userId);
  let statusResult;
  try {
    statusResult = await checkPaymentStatus(process.env.DOMPETX_API_KEY, transactionId);
  } catch (e) {
    return { status: 'pending', error: e.message };
  }
  if (!statusResult || !statusResult.success || !statusResult.data) return { status: 'pending' };
  const status = String(statusResult.data.status || '').toLowerCase();
  if (!SUCCESS_STATUSES.includes(status)) {
    return { status: status || 'pending' };
  }

  // Sukses: pastikan belum pernah dikredit (pending row masih ada) agar tidak dobel.
  let pending = null;
  try { pending = await PaymentTracker.findPendingPaymentByTransactionOrCode(transactionId); } catch (_) {}
  if (!pending) {
    // Sudah diproses sebelumnya.
    return { status: 'success', alreadyCredited: true };
  }
  const amount = statusResult.data.get_balance ? parseInt(statusResult.data.get_balance, 10) : Number(pending.amount || fallbackAmount || 0);
  await BalanceManager.updateBalance(uid, amount);
  try { await PaymentTracker.removePendingPayment(transactionId); } catch (_) {}
  return { status: 'success', credited: amount };
}

function startPoller(userId, transactionId, amount, expiryTime) {
  const interval = 10000;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (Date.now() > expiryTime + 60000) return; // berhenti setelah kadaluarsa
    try {
      const res = await checkAndCredit(userId, transactionId, amount);
      if (res.status === 'success') { stopped = true; return; }
    } catch (_) {}
    setTimeout(tick, interval).unref?.();
  };
  setTimeout(tick, interval).unref?.();
}

// Dipanggil webhook: kredit saldo berdasarkan reference (idempoten via pending payment).
async function creditByReference(reference) {
  let pending = null;
  try { pending = await PaymentTracker.findPendingPaymentByTransactionOrCode(reference); } catch (_) {}
  if (!pending) return { found: false };
  const amount = Number(pending.amount || 0);
  const uid = pending.user_id;
  if (uid && amount > 0) {
    await BalanceManager.updateBalance(uid, amount);
    try { await PaymentTracker.removePendingPayment(reference); } catch (_) {}
    return { found: true, credited: amount };
  }
  return { found: true, credited: 0 };
}

module.exports = { createDeposit, checkAndCredit, creditByReference };
