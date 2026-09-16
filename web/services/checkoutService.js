/**
 * Lapisan pembayaran (checkout) untuk web. Aturan (sama seperti bot: tidak ada gratis):
 *  - Login & saldo cukup  -> potong saldo, langsung provision.
 *  - Login tapi saldo kurang, ATAU tamu -> bayar QRIS di web, lalu provision.
 *
 * Memisahkan "pembayaran" dari "provisioning" (rdpService.provisionOrder/provisionInstall).
 */
const QRCode = require('qrcode');
const rdpService = require('./rdpService');
const { createPayment, checkPaymentStatus } = require('../../src/utils/payment');
const { getUser, getBalance, deductBalance, isAdmin } = require('../../src/utils/userManager');

const SUCCESS_STATUSES = ['success', 'settlement', 'capture', 'paid', 'completed'];
const checkouts = new Map(); // transactionId -> checkout

function canUseBalance(uid, amount) {
  return (async () => {
    if (!uid) return false;
    if (isAdmin(uid)) return true;
    const bal = await getBalance(uid);
    const n = typeof bal === 'string' ? 0 : Number(bal);
    return n >= amount;
  })();
}

async function makeQris(uid, prefix, amount) {
  const uniqueCode = `${prefix}${Date.now()}${uid || 'g'}`;
  const payment = await createPayment(process.env.DOMPETX_API_KEY, uniqueCode, amount);
  if (!payment || !payment.success || !payment.data || !payment.data.qr_string) {
    return { ok: false, error: (payment && payment.error) || 'Gagal membuat QRIS.' };
  }
  let qrImage = null;
  try { qrImage = await QRCode.toDataURL(payment.data.qr_string, { width: 320, margin: 1 }); } catch (_) {}
  const expiresAt = payment.data.expired_at ? new Date(payment.data.expired_at).getTime() : (Date.now() + 30 * 60 * 1000);
  return { ok: true, transactionId: payment.data.id, qrString: payment.data.qr_string, qrImage: qrImage || payment.data.qr_image || null, expiresAt };
}

// ---------- ORDER ----------
async function startOrder(uid, params) {
  const amt = await rdpService.getOrderAmount(params.productId, params.durationDays);
  if (!amt.ok) return amt;
  const amount = amt.amount;

  if (await canUseBalance(uid, amount)) {
    // Bayar pakai saldo.
    const reserved = await rdpService.reserveOrderSlot(params.productId, params.durationDays);
    if (!reserved) return { ok: false, error: 'Slot untuk durasi ini sudah habis.' };
    let charged = false;
    if (!isAdmin(uid)) {
      const ok = await deductBalance(uid, amount);
      if (!ok) { await rdpService.releaseOrderSlot(params.productId, params.durationDays); return { ok: false, error: 'Gagal memotong saldo.' }; }
      charged = true;
    }
    const refund = charged ? { uid, amount } : null;
    const res = await rdpService.provisionOrder(uid, params, { refund });
    if (!res.ok) {
      // Kegagalan sinkron (produk/OS/token) — provisionOrder sudah release slot; refund saldo.
      if (charged) { try { const { addBalance } = require('../../src/utils/userManager'); await addBalance(uid, amount); } catch (_) {} }
      return res;
    }
    return { ok: true, mode: 'balance', jobId: res.jobId, amount };
  }

  // Bayar via QRIS (tamu / saldo kurang). Reserve slot dulu agar tidak keburu habis
  // setelah bayar; dilepas otomatis kalau tak terbayar sampai kadaluarsa.
  const reserved = await rdpService.reserveOrderSlot(params.productId, params.durationDays);
  if (!reserved) return { ok: false, error: 'Slot untuk durasi ini sudah habis.' };
  const q = await makeQris(uid, 'ORD', amount);
  if (!q.ok) { await rdpService.releaseOrderSlot(params.productId, params.durationDays); return q; }

  checkouts.set(q.transactionId, {
    type: 'order', uid: uid || 0, refundUid: uid || null, params, amount,
    productId: params.productId, durationDays: params.durationDays,
    transactionId: q.transactionId, status: 'awaiting_payment', jobId: null,
    reserved: true, finalizing: false, expiresAt: q.expiresAt
  });
  startPoller(q.transactionId);
  return { ok: true, mode: 'qris', transactionId: q.transactionId, amount, qrImage: q.qrImage, qrString: q.qrString, expiresAt: q.expiresAt };
}

// ---------- INSTALL ----------
async function startInstall(uid, params) {
  // Validasi input dulu supaya tamu tidak bayar untuk data yang tidak valid.
  const v = rdpService.validateInstallParams(params);
  if (!v.ok) return v;
  const amount = await rdpService.getInstallCost();

  if (await canUseBalance(uid, amount)) {
    let charged = false;
    if (!isAdmin(uid) && amount > 0) {
      const ok = await deductBalance(uid, amount);
      if (!ok) return { ok: false, error: 'Gagal memotong saldo.' };
      charged = true;
    }
    const refund = charged ? { uid, amount } : null;
    const res = await rdpService.provisionInstall(uid, params, { refund });
    if (!res.ok) {
      if (charged) { try { const { addBalance } = require('../../src/utils/userManager'); await addBalance(uid, amount); } catch (_) {} }
      return res;
    }
    return { ok: true, mode: 'balance', jobId: res.jobId, amount };
  }

  const q = await makeQris(uid, 'INS', amount);
  if (!q.ok) return q;
  checkouts.set(q.transactionId, {
    type: 'install', uid: uid || 0, refundUid: uid || null, params, amount,
    transactionId: q.transactionId, status: 'awaiting_payment', jobId: null,
    reserved: false, finalizing: false, expiresAt: q.expiresAt
  });
  startPoller(q.transactionId);
  return { ok: true, mode: 'qris', transactionId: q.transactionId, amount, qrImage: q.qrImage, qrString: q.qrString, expiresAt: q.expiresAt };
}

// Provision setelah pembayaran QRIS sukses (idempoten).
async function finalize(co) {
  if (co.jobId) return co.jobId;
  if (co.finalizing) return null;
  co.finalizing = true;
  try {
    const refund = co.refundUid ? { uid: co.refundUid, amount: co.amount } : null;
    let res;
    if (co.type === 'order') res = await rdpService.provisionOrder(co.uid, co.params, { refund });
    else res = await rdpService.provisionInstall(co.uid, co.params, { refund });
    if (res && res.ok) { co.jobId = res.jobId; co.status = 'paid'; return res.jobId; }
    co.status = 'provision_failed';
    co.error = (res && res.error) || 'Provision gagal.';
    return null;
  } finally {
    co.finalizing = false;
  }
}

async function status(transactionId) {
  const co = checkouts.get(transactionId);
  if (!co) return { status: 'not_found' };
  if (co.jobId) return { status: 'paid', jobId: co.jobId };
  let sr;
  try { sr = await checkPaymentStatus(process.env.DOMPETX_API_KEY, transactionId); } catch (_) { return { status: co.status }; }
  if (sr && sr.success && sr.data && SUCCESS_STATUSES.includes(String(sr.data.status || '').toLowerCase())) {
    const jobId = await finalize(co);
    if (jobId) return { status: 'paid', jobId };
    return { status: 'provision_failed', error: co.error };
  }
  return { status: co.status || 'awaiting_payment' };
}

function startPoller(transactionId) {
  const interval = 10000;
  const tick = async () => {
    const co = checkouts.get(transactionId);
    if (!co || co.jobId) return;
    if (Date.now() > co.expiresAt + 60000) {
      // Kadaluarsa tanpa bayar: lepas slot order yang direserve.
      if (co.type === 'order' && co.reserved) { try { await rdpService.releaseOrderSlot(co.productId, co.durationDays); } catch (_) {} co.reserved = false; }
      co.status = 'expired';
      setTimeout(() => checkouts.delete(transactionId), 5 * 60 * 1000).unref?.();
      return;
    }
    try { await status(transactionId); } catch (_) {}
    const cur = checkouts.get(transactionId);
    if (cur && !cur.jobId) setTimeout(tick, interval).unref?.();
  };
  setTimeout(tick, interval).unref?.();
}

module.exports = { startOrder, startInstall, status };
