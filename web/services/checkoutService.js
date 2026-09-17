/**
 * Lapisan pembayaran (checkout) generik untuk semua layanan web.
 * Aturan (sama seperti bot, tidak ada gratis):
 *  - Login & saldo cukup -> potong saldo, langsung provision.
 *  - Login saldo kurang / tamu -> bayar QRIS, lalu provision.
 *
 * Setiap layanan mengekspos prepare(params) -> { ok, amount, [reserve, release,] provision(uid,opts) }.
 */
const QRCode = require('qrcode');
const { createPayment, checkPaymentStatus } = require('../../src/utils/payment');
const { getBalance, deductBalance, addBalance, isAdmin } = require('../../src/utils/userManager');

const rdp = require('./rdpService');
const vpsService = require('./vpsService');
const cloud9Service = require('./cloud9Service');
const fastpanelService = require('./fastpanelService');

const SUCCESS_STATUSES = ['success', 'settlement', 'capture', 'paid', 'completed'];
const checkouts = new Map();

// kind -> { type: 'order'|'install', prepare, prefix }
const registry = {
  rdp_order:        { type: 'order',   prepare: rdp.prepareOrder,             prefix: 'RDP' },
  vps_order:        { type: 'order',   prepare: vpsService.prepareOrder,      prefix: 'VPS' },
  cloud9_order:     { type: 'order',   prepare: cloud9Service.prepareOrder,   prefix: 'C9O' },
  fastpanel_order:  { type: 'order',   prepare: fastpanelService.prepareOrder,prefix: 'FPO' },
  rdp_install:      { type: 'install', prepare: rdp.prepareInstall,           prefix: 'RIN' },
  cloud9_install:   { type: 'install', prepare: cloud9Service.prepareInstall, prefix: 'C9I' },
  fastpanel_install:{ type: 'install', prepare: fastpanelService.prepareInstall, prefix: 'FPI' }
};

async function canUseBalance(uid, amount) {
  if (!uid) return false;
  if (isAdmin(uid)) return true;
  const bal = await getBalance(uid);
  const n = typeof bal === 'string' ? 0 : Number(bal);
  return n >= amount;
}

async function makeQris(uid, prefix, amount) {
  const uniqueCode = `${prefix}${Date.now()}${uid || 'g'}`;
  const payment = await createPayment(process.env.DOMPETX_API_KEY, uniqueCode, amount);
  if (!payment || !payment.success || !payment.data) {
    return { ok: false, error: (payment && payment.error) || 'Gagal membuat pembayaran.' };
  }
  const d = payment.data;
  // Sebagian gateway (mis. Valqenix) mengembalikan payment_link, bukan qr_string.
  if (!d.qr_string && !d.qr_image && !d.payment_url) {
    return { ok: false, error: 'Gateway tidak mengembalikan QR/link pembayaran.' };
  }
  let qrImage = d.qr_image || null;
  if (!qrImage && d.qr_string) { try { qrImage = await QRCode.toDataURL(d.qr_string, { width: 320, margin: 1 }); } catch (_) {} }
  const expiresAt = d.expired_at ? new Date(d.expired_at).getTime() : (Date.now() + 30 * 60 * 1000);
  return { ok: true, transactionId: d.id, qrString: d.qr_string || null, qrImage, paymentUrl: d.payment_url || null, expiresAt };
}

/**
 * Mulai checkout untuk layanan apa pun.
 * @param {string|null} uid  telegram id (null = tamu)
 * @param {string} kind      salah satu key registry
 * @param {object} params    parameter layanan
 */
async function start(uid, kind, params) {
  const svc = registry[kind];
  if (!svc) return { ok: false, error: 'Layanan tidak dikenal.' };
  const prep = await svc.prepare(params || {});
  if (!prep.ok) return prep;
  const amount = Number(prep.amount) || 0;
  const isOrder = svc.type === 'order';

  // Bayar pakai saldo (login & cukup).
  if (await canUseBalance(uid, amount)) {
    if (isOrder && prep.reserve) {
      const r = await prep.reserve();
      if (!r) return { ok: false, error: 'Slot/stok untuk pilihan ini sudah habis.' };
    }
    let charged = false;
    if (!isAdmin(uid) && amount > 0) {
      const ok = await deductBalance(uid, amount);
      if (!ok) { if (isOrder && prep.release) await prep.release(); return { ok: false, error: 'Gagal memotong saldo.' }; }
      charged = true;
    }
    const refund = charged ? { uid, amount } : null;
    const res = await prep.provision(uid, { refund });
    if (!res.ok) {
      if (charged) { try { await addBalance(uid, amount); } catch (_) {} }
      if (isOrder && prep.release) await prep.release();
      return res;
    }
    return { ok: true, mode: 'balance', jobId: res.jobId, amount };
  }

  // Bayar via QRIS (tamu / saldo kurang).
  if (isOrder && prep.reserve) {
    const r = await prep.reserve();
    if (!r) return { ok: false, error: 'Slot/stok untuk pilihan ini sudah habis.' };
  }
  const q = await makeQris(uid, svc.prefix, amount);
  if (!q.ok) { if (isOrder && prep.release) await prep.release(); return q; }

  checkouts.set(q.transactionId, {
    kind, isOrder, amount, refundUid: uid || null, prep,
    transactionId: q.transactionId, jobId: null, finalizing: false,
    reserved: !!(isOrder && prep.reserve), expiresAt: q.expiresAt
  });
  startPoller(q.transactionId);
  return { ok: true, mode: 'qris', transactionId: q.transactionId, amount, qrImage: q.qrImage, qrString: q.qrString, paymentUrl: q.paymentUrl, expiresAt: q.expiresAt };
}

async function finalize(co) {
  if (co.jobId) return co.jobId;
  if (co.finalizing) return null;
  co.finalizing = true;
  try {
    const refund = co.refundUid ? { uid: co.refundUid, amount: co.amount } : null;
    const res = await co.prep.provision(co.refundUid || 0, { refund });
    if (res && res.ok) { co.jobId = res.jobId; co.status = 'paid'; return res.jobId; }
    co.status = 'provision_failed';
    co.error = (res && res.error) || 'Provision gagal.';
    if (co.isOrder && co.prep.release) { try { await co.prep.release(); } catch (_) {} }
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
  try { sr = await checkPaymentStatus(process.env.DOMPETX_API_KEY, transactionId); } catch (_) { return { status: co.status || 'awaiting_payment' }; }
  if (sr && sr.success && sr.data && SUCCESS_STATUSES.includes(String(sr.data.status || '').toLowerCase())) {
    const jobId = await finalize(co);
    if (jobId) return { status: 'paid', jobId };
    return { status: 'provision_failed', error: co.error };
  }
  return { status: co.status || 'awaiting_payment' };
}

function startPoller(transactionId) {
  const tick = async () => {
    const co = checkouts.get(transactionId);
    if (!co || co.jobId) return;
    if (Date.now() > co.expiresAt + 60000) {
      if (co.isOrder && co.reserved && co.prep.release) { try { await co.prep.release(); } catch (_) {} co.reserved = false; }
      co.status = 'expired';
      setTimeout(() => checkouts.delete(transactionId), 5 * 60 * 1000).unref?.();
      return;
    }
    try { await status(transactionId); } catch (_) {}
    const cur = checkouts.get(transactionId);
    if (cur && !cur.jobId) setTimeout(tick, 10000).unref?.();
  };
  setTimeout(tick, 10000).unref?.();
}

module.exports = { start, status };
