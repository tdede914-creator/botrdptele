/**
 * Order Fastpanel (auto create VPS + install, semua provider) & Jasa Install
 * Fastpanel di VPS milik user. Reuse fastpanelManager + fastpanelInstaller + doApi.
 */
const fastpanelManager = require('../../src/utils/fastpanelManager');
const vpsManager = require('../../src/utils/vpsManager');
const adminSettings = require('../../src/utils/adminSettings');
const { installFastpanel } = require('../../src/utils/fastpanelInstaller');
const { createDroplet, waitPublicIp, deleteDroplet, isAwsToken, isLinodeToken, isUpCloudToken } = require('../../src/utils/doApi');
const { addBalance } = require('../../src/utils/userManager');
const rdp = require('./rdpService');
const { newJob, setJob, pushLog, genAlphaNum, genWindowsPassword, rootCloudInit } = rdp._shared;

function priceByDuration(prod, days) {
  return Number(days) === 7 ? (Number(prod.price_weekly) || Number(prod.price)) : Number(prod.price);
}
function slotByDuration(prod, days) {
  return Number(days) === 7 ? Number(prod.slot_weekly || 0) : Number(prod.slot_monthly || prod.slot || 0);
}
function ubuntuImageForToken(token) {
  if (isAwsToken(token)) return 'aws:ubuntu22.04';
  if (isLinodeToken(token)) return 'linode/ubuntu22.04';
  if (isUpCloudToken(token)) return 'upcloud/ubuntu22.04';
  return 'ubuntu-22-04-x64';
}
function regionForToken(token) {
  if (isAwsToken(token)) {
    try { const o = JSON.parse(Buffer.from(String(token).replace(/^aws:/, ''), 'base64').toString('utf8')); return o.region || 'us-east-1'; } catch (_) { return 'us-east-1'; }
  }
  if (isLinodeToken(token)) return process.env.FASTPANEL_LINODE_REGION || 'us-east';
  if (isUpCloudToken(token)) return process.env.FASTPANEL_UPCLOUD_REGION || 'sg-sin1';
  return process.env.FASTPANEL_DO_REGION || 'sgp1';
}
function genFastpanelPass() {
  const raw = require('crypto').randomBytes(20).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return `Fp${raw.slice(0, 14)}!9`;
}
function mkLog(jobId, tag) { return (m) => { console.log(`[${tag}] ${m}`); pushLog(jobId, m); }; }

async function listProducts() {
  const rows = await fastpanelManager.listActiveProducts();
  return (rows || []).map((p) => ({
    id: p.id, ram: Number(p.ram), core: Number(p.core), size_slug: p.size_slug,
    provider: fastpanelManager.apiProviderKey ? undefined : undefined,
    price_weekly: p.price_weekly != null ? Number(p.price_weekly) : null,
    price_monthly: p.price != null ? Number(p.price) : null,
    slot_weekly: Number(p.slot_weekly || 0), slot_monthly: Number(p.slot_monthly || p.slot || 0)
  }));
}

async function prepareOrder(params) {
  const days = Number(params.durationDays) === 7 ? 7 : 30;
  const prod = await fastpanelManager.getProduct(params.productId);
  if (!prod) return { ok: false, error: 'Produk Fastpanel tidak ditemukan.' };
  if (slotByDuration(prod, days) <= 0) return { ok: false, error: 'Slot untuk durasi ini habis.' };
  const amount = priceByDuration(prod, days);
  if (!amount) return { ok: false, error: 'Harga durasi ini belum di-set admin.' };
  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return { ok: false, error: 'API cloud tidak ditemukan/nonaktif.' };
  return {
    ok: true, amount,
    reserve: () => fastpanelManager.decrementStock(params.productId, days).then(() => true).catch(() => false),
    release: () => fastpanelManager.incrementStock(params.productId, days).catch(() => {}),
    provision: (uid, opts) => provisionOrder(uid, { productId: params.productId, days }, opts)
  };
}

async function provisionOrder(uid, { productId, days }, opts = {}) {
  uid = String(uid || 0);
  const prod = await fastpanelManager.getProduct(productId);
  if (!prod) { await fastpanelManager.incrementStock(productId, days).catch(() => {}); return { ok: false, error: 'Produk tidak ditemukan.' }; }
  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) { await fastpanelManager.incrementStock(productId, days).catch(() => {}); return { ok: false, error: 'API cloud tidak ditemukan.' }; }
  const region = regionForToken(token);
  const image = ubuntuImageForToken(token);
  const rootPass = genAlphaNum(12);
  const fpPass = genFastpanelPass();
  const refund = (opts.refund && opts.refund.uid) ? opts.refund : null;
  const jobId = newJob(uid, 'fastpanel');
  setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Membuat VPS untuk Fastpanel...', progress: 15 });

  (async () => {
    let dropletId = null;
    try {
      const created = await createDroplet(token, `fastpanel-${genAlphaNum(6).toLowerCase()}`, region, prod.size_slug, image, rootCloudInit(rootPass));
      dropletId = created.dropletId;
      if (!dropletId) { await fastpanelManager.incrementStock(productId, days).catch(() => {}); if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} } setJob(jobId, { status: 'failed', step: 'create_vps', message: 'Gagal membuat VPS: ' + (created.error || 'unknown') }); return; }
      setJob(jobId, { step: 'wait_ip', message: 'Menunggu IP publik...', progress: 40 });
      const ip = await waitPublicIp(token, dropletId, 40, 10000, region);
      if (!ip) { try { await deleteDroplet(token, dropletId, region); } catch (_) {} await fastpanelManager.incrementStock(productId, days).catch(() => {}); if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} } setJob(jobId, { status: 'failed', step: 'wait_ip', message: 'IP VPS belum tersedia.' }); return; }
      setJob(jobId, { step: 'installing', message: 'Menginstall Fastpanel...', progress: 60, server: { ip, port: 8888 } });
      const result = await installFastpanel(ip, 'root', rootPass, { fastpanelUser: 'fastuser', fastpanelPassword: fpPass, sshMaxWaitMs: 12 * 60 * 1000 }, mkLog(jobId, `web-fp ${ip}`));
      const nowSec = Math.floor(Date.now() / 1000);
      try { await require('../../src/utils/userManager').getUser(uid); } catch (_) {} // pastikan baris users ada (FK), termasuk tamu (uid 0)
      await vpsManager.createVpsInstance({ userId: uid, apiId: prod.api_id, productId: prod.id, dropletId, ip, region, image: `fastpanel:${image}`, rootPassword: rootPass, expiresAt: nowSec + days * 86400, durationDays: days });
      setJob(jobId, { status: 'ready', step: 'done', message: 'Fastpanel siap digunakan!', progress: 100, server: { ip, port: result.port || 8888, url: result.url || `https://${ip}:8888/`, username: result.username, password: result.password } });
    } catch (e) {
      console.error('[web] fastpanel order error:', e);
      try { if (dropletId) await deleteDroplet(token, dropletId, region); } catch (_) {}
      await fastpanelManager.incrementStock(productId, days).catch(() => {});
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
  const amount = await adminSettings.getNumber('fastpanel_install_price', 15000);
  return { ok: true, amount, provision: (uid, opts) => provisionInstall(uid, params, opts) };
}

async function provisionInstall(uid, { ip, sshUser, sshPassword }, opts = {}) {
  uid = String(uid || 0);
  const refund = (opts.refund && opts.refund.uid) ? opts.refund : null;
  const fpPass = genFastpanelPass();
  const jobId = newJob(uid, 'fastpanel_install');
  setJob(jobId, { status: 'installing', step: 'installing', message: 'Menginstall Fastpanel...', progress: 40 });
  (async () => {
    try {
      const result = await installFastpanel(ip, sshUser || 'root', sshPassword, { fastpanelUser: 'fastuser', fastpanelPassword: fpPass, sshMaxWaitMs: 8 * 60 * 1000 }, mkLog(jobId, `web-fp-install ${ip}`));
      setJob(jobId, { status: 'ready', step: 'done', message: 'Fastpanel siap digunakan!', progress: 100, server: { ip, port: result.port || 8888, url: result.url || `https://${ip}:8888/`, username: result.username, password: result.password } });
    } catch (e) {
      console.error('[web] fastpanel install error:', e);
      if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
      setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal install Fastpanel: ' + (e.message || e) + (refund ? ' (saldo dikembalikan).' : '') });
    }
  })();
  return { ok: true, jobId };
}

module.exports = { listProducts, prepareOrder, prepareInstall };
