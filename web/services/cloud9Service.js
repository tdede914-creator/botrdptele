/**
 * Order Cloud9 (auto create VPS + install, AWS-only mengikuti bot) & Jasa Install
 * Cloud9 di VPS milik user. Reuse cloud9Manager + cloud9Installer + doApi.
 */
const cloud9Manager = require('../../src/utils/cloud9Manager');
const vpsManager = require('../../src/utils/vpsManager');
const adminSettings = require('../../src/utils/adminSettings');
const { installCloud9 } = require('../../src/utils/cloud9Installer');
const { createDroplet, waitPublicIp, deleteDroplet, isAwsToken, isUpCloudToken } = require('../../src/utils/doApi');
const { addBalance } = require('../../src/utils/userManager');
const rdp = require('./rdpService');
const { newJob, setJob, pushLog, genAlphaNum, rootCloudInit } = rdp._shared;

const CLOUD9_PORT_DEFAULT = 8000;
const CLOUD9_PORT_UPCLOUD = 8880;

function priceByDuration(prod, days) {
  return Number(days) === 7 ? (Number(prod.price_weekly) || Number(prod.price)) : Number(prod.price);
}
function slotByDuration(prod, days) {
  return Number(days) === 7 ? Number(prod.slot_weekly || 0) : Number(prod.slot_monthly || prod.slot || 0);
}
function awsRegionFromToken(token) {
  try {
    const body = String(token).replace(/^aws:/, '');
    const obj = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    return obj.region || obj.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  } catch (_) { return process.env.AWS_DEFAULT_REGION || 'us-east-1'; }
}
function mkLog(jobId, tag) {
  return (m) => { console.log(`[${tag}] ${m}`); pushLog(jobId, m); };
}

async function listProducts() {
  const rows = await cloud9Manager.listActiveProducts();
  return (rows || []).map((p) => ({
    id: p.id, ram: Number(p.ram), core: Number(p.core), size_slug: p.size_slug,
    price_weekly: p.price_weekly != null ? Number(p.price_weekly) : null,
    price_monthly: p.price != null ? Number(p.price) : null,
    slot_weekly: Number(p.slot_weekly || 0), slot_monthly: Number(p.slot_monthly || p.slot || 0)
  }));
}

async function prepareOrder(params) {
  const days = Number(params.durationDays) === 7 ? 7 : 30;
  const prod = await cloud9Manager.getProduct(params.productId);
  if (!prod) return { ok: false, error: 'Produk Cloud9 tidak ditemukan.' };
  if (slotByDuration(prod, days) <= 0) return { ok: false, error: 'Slot untuk durasi ini habis.' };
  const amount = priceByDuration(prod, days);
  if (!amount) return { ok: false, error: 'Harga durasi ini belum di-set admin.' };
  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return { ok: false, error: 'API cloud tidak ditemukan/nonaktif.' };
  if (!isAwsToken(token)) return { ok: false, error: 'Order Cloud9 hanya mendukung API AWS.' };
  return {
    ok: true, amount,
    reserve: () => cloud9Manager.decrementStock(params.productId, days).then(() => true).catch(() => false),
    release: () => cloud9Manager.incrementStock(params.productId, days).catch(() => {}),
    provision: (uid, opts) => provisionOrder(uid, { productId: params.productId, days }, opts)
  };
}

async function provisionOrder(uid, { productId, days }, opts = {}) {
  uid = String(uid || 0);
  const prod = await cloud9Manager.getProduct(productId);
  if (!prod) { await cloud9Manager.incrementStock(productId, days).catch(() => {}); return { ok: false, error: 'Produk tidak ditemukan.' }; }
  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) { await cloud9Manager.incrementStock(productId, days).catch(() => {}); return { ok: false, error: 'API cloud tidak ditemukan.' }; }
  const region = awsRegionFromToken(token);
  const rootPass = genAlphaNum(12);
  const refund = (opts.refund && opts.refund.uid) ? opts.refund : null;
  const jobId = newJob(uid, 'cloud9');
  setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Membuat VPS untuk Cloud9...', progress: 15 });

  (async () => {
    let dropletId = null;
    try {
      const created = await createDroplet(token, `cloud9-${genAlphaNum(6).toLowerCase()}`, region, prod.size_slug, 'ubuntu-22.04', rootCloudInit(rootPass));
      dropletId = created.dropletId;
      if (!dropletId) { await cloud9Manager.incrementStock(productId, days).catch(() => {}); if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} } setJob(jobId, { status: 'failed', step: 'create_vps', message: 'Gagal membuat VPS: ' + (created.error || 'unknown') }); return; }
      setJob(jobId, { step: 'wait_ip', message: 'Menunggu IP publik...', progress: 40 });
      const ip = await waitPublicIp(token, dropletId, 40, 10000, region);
      if (!ip) { try { await deleteDroplet(token, dropletId, region); } catch (_) {} await cloud9Manager.incrementStock(productId, days).catch(() => {}); if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} } setJob(jobId, { status: 'failed', step: 'wait_ip', message: 'IP VPS belum tersedia.' }); return; }
      const c9Port = isUpCloudToken(token) ? CLOUD9_PORT_UPCLOUD : CLOUD9_PORT_DEFAULT;
      setJob(jobId, { step: 'installing', message: 'Menginstall Cloud9 IDE...', progress: 60, server: { ip, port: c9Port } });
      const result = await installCloud9(ip, 'root', rootPass, { sshMaxWaitMs: 12 * 60 * 1000, cloud9Port: c9Port }, mkLog(jobId, `web-c9 ${ip}`));
      const nowSec = Math.floor(Date.now() / 1000);
      await vpsManager.createVpsInstance({ userId: uid, apiId: prod.api_id, productId: prod.id, dropletId, ip, region, image: 'cloud9:ubuntu-22.04', rootPassword: rootPass, expiresAt: nowSec + days * 86400, durationDays: days });
      setJob(jobId, { status: 'ready', step: 'done', message: 'Cloud9 siap digunakan!', progress: 100, server: { ip, port: result.port || c9Port, url: `http://${ip}:${result.port || c9Port}`, username: result.username, password: result.password } });
    } catch (e) {
      console.error('[web] cloud9 order error:', e);
      try { if (dropletId) await deleteDroplet(token, dropletId, region); } catch (_) {}
      await cloud9Manager.incrementStock(productId, days).catch(() => {});
      if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
      setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal: ' + (e.message || e) + (refund ? ' (saldo dikembalikan).' : '') });
    }
  })();
  return { ok: true, jobId };
}

async function prepareInstall(params) {
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(String(params.ip || ''))) return { ok: false, error: 'Format IP tidak valid.' };
  if (!params.sshPassword) return { ok: false, error: 'Password SSH VPS wajib diisi.' };
  const amount = await adminSettings.getNumber('cloud9_install_price', 10000);
  return { ok: true, amount, provision: (uid, opts) => provisionInstall(uid, params, opts) };
}

async function provisionInstall(uid, { ip, sshUser, sshPassword }, opts = {}) {
  uid = String(uid || 0);
  const refund = (opts.refund && opts.refund.uid) ? opts.refund : null;
  const jobId = newJob(uid, 'cloud9_install');
  setJob(jobId, { status: 'installing', step: 'installing', message: 'Menginstall Cloud9 IDE...', progress: 40 });
  (async () => {
    try {
      const result = await installCloud9(ip, sshUser || 'root', sshPassword, { sshMaxWaitMs: 8 * 60 * 1000, cloud9Port: CLOUD9_PORT_DEFAULT }, mkLog(jobId, `web-c9-install ${ip}`));
      setJob(jobId, { status: 'ready', step: 'done', message: 'Cloud9 siap digunakan!', progress: 100, server: { ip, port: result.port || CLOUD9_PORT_DEFAULT, url: `http://${ip}:${result.port || CLOUD9_PORT_DEFAULT}`, username: result.username, password: result.password } });
    } catch (e) {
      console.error('[web] cloud9 install error:', e);
      if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
      setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal install Cloud9: ' + (e.message || e) + (refund ? ' (saldo dikembalikan).' : '') });
    }
  })();
  return { ok: true, jobId };
}

module.exports = { listProducts, prepareOrder, prepareInstall };
