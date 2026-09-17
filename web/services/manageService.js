/**
 * Kelola VPS/RDP milik user (khusus pemilik): list, power ON/OFF, hapus, REBUILD.
 *
 * Rebuild meniru perilaku bot (vpsOrderHandler.executeServiceAction):
 *   - TANPA biaya tambahan (tidak memotong saldo).
 *   - Masa aktif (expires_at/duration_days) TIDAK diubah — ikut order awal.
 *   - Tipe layanan dipertahankan: RDP->RDP, VPS->VPS, Cloud9->Cloud9,
 *     Fastpanel->Fastpanel (otomatis install ulang sesuai tipe).
 *   - Buat droplet baru dulu, update baris vps_instances yang SAMA, lalu hapus
 *     droplet lama (create-new-then-delete-old). Fallback ke API lain bila API
 *     asal mati (rebalance stok + updateVpsInstanceApiProduct).
 */
const crypto = require('crypto');
const vpsManager = require('../../src/utils/vpsManager');
const {
  createDroplet, waitPublicIp, deleteDroplet, powerDroplet,
  isAwsToken, isLinodeToken, isUpCloudToken, rdpPortForToken, linodeSetDirectDisk
} = require('../../src/utils/doApi');
const { installDedicatedRDP } = require('../../src/utils/dedicatedRdpInstaller');
const { installCloud9 } = require('../../src/utils/cloud9Installer');
const { installFastpanel } = require('../../src/utils/fastpanelInstaller');
const RDPMonitor = require('../../src/utils/rdpMonitor');
const { RDP_MONITOR_TIMEOUT_MS, validateWindowsPassword } = require('../../src/utils/rdpPasswordUtil');
const { DEDICATED_OS_VERSIONS } = require('../../src/config/constants');
const rdp = require('./rdpService');
const { newJob, setJob, pushLog, mkInstallLogger, mkMonitorLogger, genAlphaNum, genWindowsPassword, rootCloudInit, normalizeAwsRdpSize, waitForPort } = rdp._shared;

const CLOUD9_PORT_DEFAULT = 8000;
const CLOUD9_PORT_UPCLOUD = 8880;
const FASTPANEL_PORT = 8888;

function providerOf(token) {
  return isAwsToken(token) ? 'aws' : (isLinodeToken(token) ? 'linode' : (isUpCloudToken(token) ? 'upcloud' : 'digitalocean'));
}
function ubuntuImageForToken(token) {
  if (isAwsToken(token)) return 'aws:ubuntu22.04';
  if (isLinodeToken(token)) return 'linode/ubuntu22.04';
  if (isUpCloudToken(token)) return 'upcloud/ubuntu22.04';
  return 'ubuntu-22-04-x64';
}
function genFastpanelPass() {
  const raw = crypto.randomBytes(20).toString('base64').replace(/[^A-Za-z0-9]/g, '');
  return `Fp${raw.slice(0, 14)}!9`;
}
function osNameFromVersion(version) {
  try { const found = (DEDICATED_OS_VERSIONS || []).find((x) => x && x.version === version); return (found && found.name) || version; } catch (_) { return version; }
}

function typeOf(image) {
  const s = String(image || '').toLowerCase();
  if (s.startsWith('rdp:')) return 'RDP';
  if (s.startsWith('cloud9:')) return 'Cloud9';
  if (s.startsWith('fastpanel:')) return 'Fastpanel';
  return 'VPS';
}
function osLabel(image) {
  return String(image || '').replace(/^(rdp|cloud9|fastpanel):/, '') || '-';
}

// Daftar server milik user (aktif).
async function listServers(userId) {
  let rows = [];
  try { rows = await vpsManager.listUserVps(userId); } catch (_) { rows = []; }
  return (rows || []).map((r) => {
    const type = typeOf(r.image);
    const port = r.rdp_port || (type === 'RDP' ? 4443 : 22);
    return {
      id: r.id,
      type,
      ip: r.ip || null,
      server: r.ip ? `${r.ip}:${port}` : '-',
      port,
      region: r.region || '-',
      os: osLabel(r.image),
      size: r.size_slug || '-',
      createdAt: r.created_at || null,
      hasDroplet: !!r.droplet_id
    };
  });
}

// Ambil instance milik user (validasi kepemilikan).
async function _ownedInstance(userId, id) {
  const inst = await vpsManager.getVpsInstance(Number(id));
  if (!inst) return { error: 'Server tidak ditemukan.' };
  if (String(inst.user_id) !== String(userId)) return { error: 'Ini bukan server kamu.' };
  return { inst };
}

async function powerServer(userId, id, action) {
  const act = action === 'on' ? 'on' : 'off';
  const { inst, error } = await _ownedInstance(userId, id);
  if (error) return { ok: false, error };
  if (!inst.droplet_id) return { ok: false, error: 'Server ini tidak punya droplet ID.' };
  const apiId = inst.api_id || inst.origin_api_id;
  const token = await vpsManager.getDoApiTokenAny(apiId);
  if (!token) return { ok: false, error: 'API/akun cloud server ini tidak ditemukan.' };
  const res = await powerDroplet(token, inst.droplet_id, act, inst.region);
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'Gagal mengubah power.' };
  return { ok: true, action: act };
}

async function deleteServer(userId, id) {
  const { inst, error } = await _ownedInstance(userId, id);
  if (error) return { ok: false, error };
  const apiId = inst.api_id || inst.origin_api_id;
  const token = await vpsManager.getDoApiTokenAny(apiId);
  if (inst.droplet_id && token) {
    try { await deleteDroplet(token, inst.droplet_id, inst.region); } catch (_) {}
  }
  try { await vpsManager.markVpsDeleted(inst.id); } catch (_) {}
  // Kembalikan slot stok bila instance berasal dari produk berdurasi.
  if (inst.product_id && inst.duration_days) {
    try { await vpsManager.incrementProductSlotDuration(inst.product_id, Number(inst.duration_days)); } catch (_) {}
  }
  return { ok: true };
}

// ---- Token resolver (mirror vpsOrderHandler.resolveTokenForInstance) ----
function _uniqueIds(ids) {
  const out = [];
  for (const id of ids) { const n = Number(id); if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n); }
  return out;
}
async function resolveToken(inst, allowFallback = false, excludeApiId = null) {
  let product = null;
  try { product = await vpsManager.getProductAny(inst.product_id); } catch (_) {}
  const candidates = _uniqueIds([inst.api_id, product && product.api_id, inst.origin_api_id]);
  for (const apiId of candidates) {
    if (excludeApiId && Number(apiId) === Number(excludeApiId)) continue;
    let token = null; try { token = await vpsManager.getDoApiTokenAny(apiId); } catch (_) {}
    if (token) return { token, apiId, productId: inst.product_id, fromOriginal: true };
  }
  if (!allowFallback) return { token: null, apiId: candidates[0] || inst.api_id, productId: inst.product_id, fromOriginal: true };
  let fb = null;
  try { fb = await vpsManager.getFallbackProductForInstancePrefer(inst, excludeApiId || candidates[0]); } catch (_) {}
  if (!fb) return { token: null, apiId: null, productId: null, fromOriginal: false };
  let token = null;
  try { token = (await vpsManager.getDoApiToken(fb.api_id)) || (await vpsManager.getDoApiTokenAny(fb.api_id)); } catch (_) {}
  return { token, apiId: fb.api_id, productId: fb.id, fromOriginal: false, fallback: fb };
}

// Buat droplet baru, update baris vps_instances yang sama, hapus droplet lama.
// serviceType: 'RDP'|'VPS'|'Cloud9'|'Fastpanel'. Return { ip, rootPass, dropletId,
// apiId, productId, provider, sshPrivateKey, sshUsername } atau throw.
async function recreateDroplet(inst, serviceType, { namePrefix, region, size }) {
  const newPass = genAlphaNum(12);
  const cloudInit = rootCloudInit(newPass);

  const createWith = async (info) => {
    const token = info.token;
    // Base image: RDP/Cloud9/Fastpanel selalu Ubuntu (sesuai provider). VPS polos
    // pertahankan image aslinya bila masih dari API asal & bukan image berprefiks layanan.
    let baseImage = ubuntuImageForToken(token);
    if (serviceType === 'VPS' && info.fromOriginal && inst.image && !/^(rdp|cloud9|fastpanel):/i.test(inst.image)) baseImage = inst.image;
    const createSize = (isAwsToken(token) && serviceType === 'RDP') ? normalizeAwsRdpSize(size) : size;
    const created = await createDroplet(token, `${namePrefix}-${crypto.randomBytes(4).toString('hex')}`, region, createSize, baseImage, cloudInit);
    if (!created || !created.dropletId) return { ok: false, error: (created && created.error) || 'Gagal membuat droplet baru.', info };
    const ip = await waitPublicIp(token, created.dropletId, 30, 5000, region);
    if (!ip) { try { await deleteDroplet(token, created.dropletId, region); } catch (_) {} return { ok: false, error: 'IP droplet baru belum tersedia.', info }; }
    return { ok: true, ip, dropletId: created.dropletId, info, image: baseImage, sshPrivateKey: created.sshPrivateKey || null, sshUsername: created.sshUsername || null };
  };

  let tokenInfo = await resolveToken(inst, true);
  if (!tokenInfo.token) throw new Error('API cloud pembuatan awal tidak ditemukan & tidak ada API fallback yang tersedia.');

  let made = await createWith(tokenInfo);
  if (!made.ok && tokenInfo.fromOriginal) {
    const fbInfo = await resolveToken(inst, true, tokenInfo.apiId);
    if (fbInfo.token && Number(fbInfo.apiId) !== Number(tokenInfo.apiId)) {
      const fbMade = await createWith(fbInfo);
      if (fbMade.ok) made = fbMade;
    }
  }
  if (!made.ok) throw new Error(made.error || 'Gagal membuat droplet baru.');

  tokenInfo = made.info;
  const dropletId = made.dropletId;
  const ip = made.ip;
  const usedImage = made.image || ubuntuImageForToken(tokenInfo.token);

  // Rebalance stok bila memakai API/produk fallback.
  if (!tokenInfo.fromOriginal && tokenInfo.productId) {
    try {
      await vpsManager.decrementProductSlotDuration(tokenInfo.productId, Number(inst.duration_days) || 30);
      if (inst.product_id && Number(inst.product_id) !== Number(tokenInfo.productId)) {
        await vpsManager.incrementProductSlotDuration(inst.product_id, Number(inst.duration_days) || 30);
      }
      await vpsManager.updateVpsInstanceApiProduct(inst.id, tokenInfo.apiId, tokenInfo.productId);
    } catch (e) {
      try { await deleteDroplet(tokenInfo.token, dropletId, region); } catch (_) {}
      throw e;
    }
  }

  // Update baris yang SAMA. Expired date TIDAK diubah (updateVpsInstanceDroplet tidak menyentuh expires_at/duration_days).
  await vpsManager.updateVpsInstanceDroplet(inst.id, dropletId, ip, region, usedImage, newPass);

  // Hapus droplet lama pakai API asal pembuatannya.
  if (inst.droplet_id) {
    const oldInfo = await resolveToken(inst, false);
    if (oldInfo.token) { try { await deleteDroplet(oldInfo.token, inst.droplet_id, inst.region); } catch (_) {} }
  }

  return { ip, rootPass: newPass, dropletId, image: usedImage, apiId: tokenInfo.apiId, productId: tokenInfo.productId, provider: providerOf(tokenInfo.token), sshPrivateKey: made.sshPrivateKey || null, sshUsername: made.sshUsername || null };
}

/**
 * Rebuild server milik user. TANPA biaya, masa aktif tetap, tipe dipertahankan.
 * Mengembalikan { ok, jobId } — progres dipantau via /api/job/:id (sistem job rdpService).
 * opts (opsional, khusus RDP): { osVersion, customPassword }.
 */
async function rebuildServer(userId, id, opts = {}) {
  const { inst, error } = await _ownedInstance(userId, id);
  if (error) return { ok: false, error };
  if (Number(inst.status) !== 1) return { ok: false, error: 'Server tidak aktif.' };
  if (!inst.droplet_id) return { ok: false, error: 'Server ini tidak punya droplet ID (tidak bisa di-rebuild dari web).' };

  const type = typeOf(inst.image); // RDP | Cloud9 | Fastpanel | VPS
  const region = inst.region || 'sgp1';

  if (type === 'RDP') {
    const size = inst.size_slug || 's-2vcpu-2gb';
    const stored = String(inst.image || '').startsWith('rdp:') ? inst.image.replace('rdp:', '') : null;
    const osVersion = String(opts.osVersion || stored || 'win_2016');
    const osName = osNameFromVersion(osVersion);
    const rdpPass = (opts.customPassword && validateWindowsPassword(opts.customPassword).ok) ? opts.customPassword : genWindowsPassword();

    const jobId = newJob(userId, 'rebuild_rdp');
    setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Rebuild: membuat VPS baru...', progress: 8 });
    (async () => {
      try {
        const rb = await recreateDroplet(inst, 'RDP', { namePrefix: 'rdp', region, size });
        await vpsManager.updateVpsInstanceImage(inst.id, `rdp:${osVersion}`);
        const rdpPort = rb.provider === 'upcloud' ? 8443 : 4443;
        try { await vpsManager.updateVpsInstanceRdpPort(inst.id, rdpPort); } catch (_) {}
        // Simpan password Windows lebih awal (source of truth walau monitor timeout).
        try { await vpsManager.updateVpsInstancePassword(inst.id, rdpPass); } catch (_) {}

        setJob(jobId, { step: 'wait_ssh', message: 'Menunggu SSH siap...', progress: 30, server: { ip: rb.ip, port: rdpPort, username: 'administrator', password: rdpPass, os: osName, region } });
        const sshReady = await waitForPort(rb.ip, 22, 12 * 60 * 1000, 15000);
        if (!sshReady) { setJob(jobId, { status: 'failed', step: 'wait_ssh', message: 'VPS tidak menyala dalam 12 menit setelah rebuild. Coba rebuild lagi.' }); return; }

        setJob(jobId, { step: 'installing', message: 'Menginstall Windows RDP...', progress: 35 });
        const upKey = (rb.provider === 'upcloud' && rb.sshPrivateKey) ? rb.sshPrivateKey : null;
        const sshUser = upKey ? (rb.sshUsername || 'root') : 'root';
        const installCfg = { osVersion, password: rdpPass, provider: rb.provider || 'digitalocean', rdpPort };
        if (upKey) { installCfg.privateKey = upKey; installCfg.useSudo = sshUser !== 'root'; }
        const installPromise = installDedicatedRDP(rb.ip, sshUser, upKey ? null : rb.rootPass, installCfg, mkInstallLogger(jobId, `web-rebuild ${rb.ip}`));

        if (rb.provider === 'linode' && rb.apiId && rb.dropletId) {
          const sched = (minutes) => setTimeout(async () => {
            try { const t = await vpsManager.getDoApiTokenAny(rb.apiId); if (!isLinodeToken(t)) return; await linodeSetDirectDisk(t, rb.dropletId); }
            catch (e) { console.warn(`[web-rebuild ${rb.ip}] DD ${minutes}m`, e.message || e); }
          }, minutes * 60 * 1000);
          [5, 7, 9].forEach(sched);
        }

        await installPromise;
        setJob(jobId, { step: 'monitor', message: 'Menunggu Windows boot & RDP siap...', progress: 70 });
        const monitor = new RDPMonitor(rb.ip, sshUser, upKey ? null : rb.rootPass, rdpPass, rdpPort);
        const result = await monitor.waitForRDPReady(RDP_MONITOR_TIMEOUT_MS, mkMonitorLogger(jobId, `web-rebuild ${rb.ip}`));
        try { monitor.disconnect(); } catch (_) {}
        const server = { ip: rb.ip, port: rdpPort, username: 'administrator', password: rdpPass, os: osName, region };
        if (result && result.success && result.rdpReady) {
          setJob(jobId, { status: 'ready', step: 'done', message: 'RDP berhasil di-rebuild & siap dipakai!', progress: 100, server });
          try { const n = require('./notify'); n.orderSuccess({ event: 'REBUILD RDP', ip: `${rb.ip}:${rdpPort}`, spec: `${inst.ram || ''}GB / ${inst.core || ''} CORE`, durationDays: Number(inst.duration_days) || 30, apiId: rb.apiId || inst.api_id, region, windows: osName, buyerId: inst.user_id }); } catch (_) {}
        } else {
          setJob(jobId, { status: 'installing_timeout', step: 'monitor', message: 'RDP belum bisa dikonfirmasi otomatis (timeout). Windows kemungkinan masih boot — coba connect beberapa menit lagi.', progress: 95, server });
        }
      } catch (e) {
        console.error('[web] rebuild RDP error:', e);
        setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal rebuild: ' + (e.message || e) });
      }
    })();
    return { ok: true, jobId };
  }

  if (type === 'Cloud9') {
    const size = inst.size_slug || 's-1vcpu-1gb';
    const jobId = newJob(userId, 'rebuild_cloud9');
    setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Rebuild: membuat VPS baru...', progress: 10 });
    (async () => {
      try {
        const rb = await recreateDroplet(inst, 'Cloud9', { namePrefix: 'cloud9', region, size });
        const c9Port = rb.provider === 'upcloud' ? CLOUD9_PORT_UPCLOUD : CLOUD9_PORT_DEFAULT;
        setJob(jobId, { step: 'installing', message: 'Menginstall Cloud9 IDE...', progress: 55, server: { ip: rb.ip, port: c9Port } });
        const result = await installCloud9(rb.ip, 'root', rb.rootPass, { sshMaxWaitMs: 12 * 60 * 1000, cloud9Port: c9Port }, (m) => { console.log(`[web-rebuild-c9 ${rb.ip}] ${m}`); pushLog(jobId, m); });
        await vpsManager.updateVpsInstanceImage(inst.id, 'cloud9:ubuntu-22.04');
        const port = (result && result.port) || c9Port;
        setJob(jobId, { status: 'ready', step: 'done', message: 'Cloud9 berhasil di-rebuild & siap dipakai!', progress: 100, server: { ip: rb.ip, port, url: `http://${rb.ip}:${port}`, username: result && result.username, password: result && result.password } });
        try { const n = require('./notify'); n.cloud9Success({ apiId: rb.apiId || inst.api_id, userId: inst.user_id, ip: rb.ip, url: `http://${rb.ip}:${port}`, port, size, region, durationDays: Number(inst.duration_days) || 30 }); } catch (_) {}
      } catch (e) {
        console.error('[web] rebuild Cloud9 error:', e);
        setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal rebuild Cloud9: ' + (e.message || e) });
      }
    })();
    return { ok: true, jobId };
  }

  if (type === 'Fastpanel') {
    const size = inst.size_slug || 's-1vcpu-1gb';
    const fpPass = genFastpanelPass();
    const jobId = newJob(userId, 'rebuild_fastpanel');
    setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Rebuild: membuat VPS baru...', progress: 10 });
    (async () => {
      try {
        const rb = await recreateDroplet(inst, 'Fastpanel', { namePrefix: 'fastpanel', region, size });
        setJob(jobId, { step: 'installing', message: 'Menginstall Fastpanel...', progress: 55, server: { ip: rb.ip, port: FASTPANEL_PORT } });
        const result = await installFastpanel(rb.ip, 'root', rb.rootPass, { fastpanelUser: 'fastuser', fastpanelPassword: fpPass, sshMaxWaitMs: 12 * 60 * 1000 }, (m) => { console.log(`[web-rebuild-fp ${rb.ip}] ${m}`); pushLog(jobId, m); });
        await vpsManager.updateVpsInstanceImage(inst.id, `fastpanel:${rb.image || 'ubuntu-22-04-x64'}`);
        const port = (result && result.port) || FASTPANEL_PORT;
        const url = (result && result.url) || `https://${rb.ip}:${FASTPANEL_PORT}/`;
        setJob(jobId, { status: 'ready', step: 'done', message: 'Fastpanel berhasil di-rebuild & siap dipakai!', progress: 100, server: { ip: rb.ip, port, url, username: result && result.username, password: result && result.password } });
        try { const n = require('./notify'); n.fastpanelSuccess({ apiId: rb.apiId || inst.api_id, userId: inst.user_id, ip: rb.ip, url, port, size, region, durationDays: Number(inst.duration_days) || 30, username: result && result.username }); } catch (_) {}
      } catch (e) {
        console.error('[web] rebuild Fastpanel error:', e);
        setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal rebuild Fastpanel: ' + (e.message || e) });
      }
    })();
    return { ok: true, jobId };
  }

  // VPS polos
  const size = inst.size_slug || 's-1vcpu-1gb';
  const jobId = newJob(userId, 'rebuild_vps');
  setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Rebuild: membuat VPS baru...', progress: 15 });
  (async () => {
    try {
      const rb = await recreateDroplet(inst, 'VPS', { namePrefix: 'vps', region, size });
      setJob(jobId, { status: 'ready', step: 'done', message: 'VPS berhasil di-rebuild!', progress: 100, server: { ip: rb.ip, port: 22, username: 'root', password: rb.rootPass, region } });
      try { const n = require('./notify'); n.orderSuccess({ event: 'REBUILD VPS', ip: rb.ip, spec: `${inst.ram || ''}GB / ${inst.core || ''} CORE (${inst.size_slug || ''})`, durationDays: Number(inst.duration_days) || 30, apiId: rb.apiId || inst.api_id, region, buyerId: inst.user_id }); } catch (_) {}
    } catch (e) {
      console.error('[web] rebuild VPS error:', e);
      setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal rebuild VPS: ' + (e.message || e) });
    }
  })();
  return { ok: true, jobId };
}

module.exports = { listServers, powerServer, deleteServer, rebuildServer };
