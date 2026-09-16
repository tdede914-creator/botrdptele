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
  if (!payment || !payment.success) return { ok: false, error: (payment && payment.error) || 'Gagal membuat pembayaran QRIS.' };
  if (!payment.data || !payment.data.qr_string) return { ok: false, error: 'Data pembayaran gateway tidak lengkap.' };

  const expiryTime = payment.data.expired_at ? new Date(payment.data.expired_at).getTime() : (Date.now() + 30 * 60 * 1000);
  await PaymentTracker.addPendingPayment(uid, payment.data.id, payment.data.reff_id, amount, expiryTime);

  let qrDataUrl = null;
  try { qrDataUrl = await QRCode.toDataURL(payment.data.qr_string, { width: 320, margin: 1 }); } catch (_) {}

  // Poller latar belakang: cek status berkala & kredit otomatis saat sukses.
  startPoller(uid, payment.data.id, amount, expiryTime);

  return {
    ok: true,
    transactionId: payment.data.id,
    amount,
    qrString: payment.data.qr_string,
    qrImage: qrDataUrl || payment.data.qr_image || null,
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

module.exports = { createDeposit, checkAndCredit };
