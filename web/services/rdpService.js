/**
 * Layanan RDP untuk website — memakai ULANG modul bot yang sama sehingga
 * stok/saldo/instance tetap sinkron dengan Telegram bot.
 *
 * Alur order dibuat identik dengan rdpOrderHandler.createRdp:
 *   reserve slot -> createDroplet -> waitPublicIp -> createVpsInstance
 *   -> deductBalance -> (async) install RDP + monitor.
 */
const crypto = require('crypto');
const net = require('net');

const vpsManager = require('../../src/utils/vpsManager');
const { getRegions, getSizesForRegion, createDroplet, waitPublicIp, deleteDroplet, isLinodeToken, isAwsToken, linodeSetDirectDisk } = require('../../src/utils/doApi');
const { isAdmin, getBalance, deductBalance, addBalance } = require('../../src/utils/userManager');
const { installDedicatedRDP } = require('../../src/utils/dedicatedRdpInstaller');
const RDPMonitor = require('../../src/utils/rdpMonitor');
const { RDP_MONITOR_TIMEOUT_MS, validateWindowsPassword } = require('../../src/utils/rdpPasswordUtil');
const adminSettings = require('../../src/utils/adminSettings');
const { DEDICATED_OS_VERSIONS, DEDICATED_INSTALLATION_COST } = require('../../src/config/constants');

// ---- helpers (disalin dari rdpOrderHandler agar perilaku identik) ----
function genAlphaNum(n = 18) {
  const raw = crypto.randomBytes(48).toString('base64').replace(/[\/+=]/g, '');
  const body = raw.slice(0, Math.max(12, Number(n) || 18));
  return `${body}-KCSERVER-143`;
}
function genWindowsPassword() {
  for (let i = 0; i < 50; i++) {
    const p = genAlphaNum(14);
    if (/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{10,}$/.test(p)) return p;
  }
  return `Win${Date.now()}A1`;
}
function rootCloudInit(password) {
  return `#cloud-config
ssh_pwauth: true
disable_root: false
chpasswd:
  list: |
    root:${password}
  expire: false
write_files:
  - path: /etc/ssh/sshd_config.d/99-root-password.conf
    permissions: '0644'
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
      KbdInteractiveAuthentication yes
runcmd:
  - [ sh, -lc, "set -e; (grep -q '^PermitRootLogin' /etc/ssh/sshd_config && sed -i 's/^PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config); (grep -q '^PasswordAuthentication' /etc/ssh/sshd_config && sed -i 's/^PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config); systemctl restart ssh || systemctl restart sshd || service ssh restart || true" ]
`;
}
function normalizeAwsRdpSize(sizeSlug) {
  const map = { 't3.micro': 't2.micro', 't3.small': 't2.small', 't3.medium': 't2.medium', 't3.large': 't2.large', 't3.xlarge': 't2.xlarge', 'm5.large': 't2.large', 'm5.xlarge': 't2.xlarge' };
  return map[String(sizeSlug || '')] || String(sizeSlug || '');
}
function getStandardDedicatedOs() {
  return (DEDICATED_OS_VERSIONS || []).filter((os) =>
    os && typeof os.version === 'string' &&
    !os.version.includes('lite') &&
    !os.version.includes('uefi') &&
    os.version !== 'win_10atlas' &&
    os.version !== 'win_2025'
  );
}
function waitForPort(host, port, totalMs = 12 * 60 * 1000, intervalMs = 15000) {
  const start = Date.now();
  const tryOnce = () => new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { socket.destroy(); } catch (_) {} resolve(ok); };
    socket.setTimeout(5000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
  return (async () => {
    while (Date.now() - start < totalMs) {
      if (await tryOnce()) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  })();
}

// ---- in-memory job tracker untuk progres provisioning (dipoll frontend) ----
const jobs = new Map(); // jobId -> { status, step, message, server, createdAt, userId }
function newJob(userId) {
  const id = crypto.randomBytes(9).toString('hex');
  jobs.set(id, { id, userId: String(userId), status: 'pending', step: 'init', message: 'Menyiapkan...', server: null, createdAt: Date.now() });
  // auto-clean setelah 2 jam
  setTimeout(() => jobs.delete(id), 2 * 60 * 60 * 1000).unref?.();
  return id;
}
function setJob(id, patch) { const j = jobs.get(id); if (j) Object.assign(j, patch); }
function getJob(id, userId) {
  const j = jobs.get(id);
  if (!j) return null;
  if (String(j.userId) !== String(userId)) return null;
  return j;
}

// ---- katalog produk RDP (identik dgn menu bot) ----
async function listProducts() {
  const groups = await vpsManager.listActiveProductGroups('rdp');
  return groups.map((g) => ({
    ram: Number(g.ram),
    core: Number(g.core),
    price_daily: g.price_daily != null ? Number(g.price_daily) : null,
    price_weekly: g.price_weekly != null ? Number(g.price_weekly) : null,
    price_monthly: g.price_monthly != null ? Number(g.price_monthly) : null,
    slot_daily: Number(g.slot_daily || 0),
    slot_weekly: Number(g.slot_weekly || 0),
    slot_monthly: Number(g.slot_monthly || 0)
  }));
}

// Opsi lanjutan untuk (ram/core/durasi): produk konkret + daftar region + OS.
async function getOrderOptions(ram, core, durationDays) {
  const prod = await vpsManager.getAvailableProductBySpecDuration('rdp', Number(ram), Number(core), Number(durationDays));
  if (!prod) return { ok: false, error: 'Paket/slot untuk durasi ini tidak tersedia.' };
  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return { ok: false, error: 'API cloud tidak ditemukan / nonaktif.' };
  let regions = [];
  try { regions = await getRegions(token); } catch (_) { regions = []; }
  const d = Number(durationDays);
  const price = (d === 1) ? Number(prod.price_daily) : (d === 7 ? Number(prod.price_weekly) : Number(prod.price));
  return {
    ok: true,
    productId: prod.id,
    price,
    regions: regions.slice(0, 60).map((r) => ({ slug: r.slug, name: r.name })),
    osList: getStandardDedicatedOs().map((o) => ({ id: o.id, name: o.name, version: o.version }))
  };
}

/**
 * Buat + install RDP dari katalog (auto-provision). Mengembalikan { ok, jobId }.
 * Provisioning berjalan async; frontend memantau via getJob().
 */
async function orderRdp(userId, { productId, regionSlug, osId, durationDays, customPassword }) {
  const uid = String(userId);
  const d = Number(durationDays);
  const prod = await vpsManager.getProduct(productId);
  if (!prod) return { ok: false, error: 'Produk tidak ditemukan.' };

  const slotAvail = (d === 1) ? Number(prod.slot_daily || 0) : (d === 7 ? Number(prod.slot_weekly || 0) : Number(prod.slot_monthly || 0));
  if (slotAvail <= 0) return { ok: false, error: 'Slot untuk durasi ini sudah habis.' };

  const selectedOS = getStandardDedicatedOs().find((o) => o.id === Number(osId));
  if (!selectedOS) return { ok: false, error: 'OS Windows tidak valid.' };

  const basePrice = (d === 1) ? Number(prod.price_daily) : (d === 7 ? Number(prod.price_weekly) : Number(prod.price));
  if (!basePrice) return { ok: false, error: 'Harga untuk durasi ini belum di-set admin.' };
  const totalCost = basePrice;

  if (!isAdmin(uid)) {
    const bal = await getBalance(uid);
    const numericBal = typeof bal === 'string' ? 0 : Number(bal);
    if (numericBal < totalCost) return { ok: false, error: `Saldo tidak cukup. Butuh Rp ${totalCost.toLocaleString('id-ID')}.` };
  }

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return { ok: false, error: 'API cloud tidak ditemukan.' };

  let rdpPass;
  if (customPassword && validateWindowsPassword(customPassword).ok) rdpPass = customPassword;
  else rdpPass = genWindowsPassword();
  const rootPass = genAlphaNum(12);
  const cloudInit = rootCloudInit(rootPass);
  const hostname = `rdp-${uid}-${genAlphaNum(6).toLowerCase()}`;

  // Reserve slot dulu (hindari oversell). Kembalikan jika gagal.
  try {
    const dec = await vpsManager.decrementProductSlotDuration(productId, d);
    if (dec && dec.changes === 0) return { ok: false, error: 'Slot untuk durasi ini sudah habis.' };
  } catch (_) {
    return { ok: false, error: 'Slot untuk durasi ini sudah habis.' };
  }

  const jobId = newJob(uid);
  setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Membuat VPS...' });

  // Jalankan provisioning async.
  (async () => {
    const createSizeSlug = isAwsToken(token) ? normalizeAwsRdpSize(prod.size_slug) : prod.size_slug;
    const baseImage = isAwsToken(token) ? 'aws:ubuntu22.04' : (isLinodeToken(token) ? 'linode/ubuntu22.04' : 'ubuntu-22-04-x64');
    let dropletId = null;
    try {
      const created = await createDroplet(token, hostname, regionSlug, createSizeSlug, baseImage, cloudInit);
      dropletId = created.dropletId;
      if (!dropletId) {
        try { await vpsManager.incrementProductSlotDuration(productId, d); } catch (_) {}
        setJob(jobId, { status: 'failed', step: 'create_vps', message: 'Gagal membuat VPS: ' + (created.error || 'unknown') });
        return;
      }

      setJob(jobId, { step: 'wait_ip', message: 'Menunggu IP publik...' });
      const ip = await waitPublicIp(token, dropletId, 20, 10000, regionSlug);
      if (!ip) {
        try { await deleteDroplet(token, dropletId, regionSlug); } catch (_) {}
        try { await vpsManager.incrementProductSlotDuration(productId, d); } catch (_) {}
        setJob(jobId, { status: 'failed', step: 'wait_ip', message: 'IP VPS belum tersedia. Coba region lain.' });
        return;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const expiresAt = nowSec + (d * 86400);
      await vpsManager.createVpsInstance({
        userId: uid, apiId: prod.api_id, productId: prod.id, dropletId, ip,
        region: regionSlug, image: `rdp:${selectedOS.version}`, rootPassword: rdpPass,
        expiresAt, durationDays: d
      });

      // Potong saldo hanya setelah VPS berhasil dibuat (slot sudah direserve).
      if (!isAdmin(uid)) await deductBalance(uid, totalCost);

      setJob(jobId, { step: 'wait_ssh', message: 'Menunggu SSH siap...', server: { ip, port: 4443, username: 'administrator', password: rdpPass, os: selectedOS.name, region: regionSlug } });

      const sshReady = await waitForPort(ip, 22, 12 * 60 * 1000, 15000);
      if (!sshReady) {
        setJob(jobId, { status: 'failed', step: 'wait_ssh', message: 'SSH tidak siap. Cek VPS lalu rebuild.' });
        return;
      }

      setJob(jobId, { step: 'installing', message: 'Menginstall Windows RDP...' });
      const provider = isAwsToken(token) ? 'aws' : (isLinodeToken(token) ? 'linode' : 'digitalocean');
      const installPromise = installDedicatedRDP(ip, 'root', rootPass, { osVersion: selectedOS.version, password: rdpPass, provider }, (m) => console.log(`[web ${ip}] ${m}`));

      // Linode Direct Disk dipicu event reboot nyata (sama seperti perbaikan 4b).
      if (isLinodeToken(token)) {
        const setDD = async (tag) => { try { await linodeSetDirectDisk(token, dropletId); } catch (e) { console.warn(`[web ${ip}] DD ${tag}`, e.message || e); } };
        installPromise.then(() => { setDD('r+0'); setTimeout(() => setDD('r+90'), 90000); setTimeout(() => setDD('r+180'), 180000); setTimeout(() => setDD('r+300'), 300000); }).catch(() => setTimeout(() => setDD('fb+240'), 240000));
      }

      await installPromise;
      const monitor = new RDPMonitor(ip, 'root', rootPass, rdpPass, 4443);
      const result = await monitor.waitForRDPReady(RDP_MONITOR_TIMEOUT_MS, (s) => console.log(`[web ${ip}] ${s}`));
      try { monitor.disconnect(); } catch (_) {}

      if (result && result.success && result.rdpReady) {
        setJob(jobId, { status: 'ready', step: 'done', message: 'RDP siap digunakan!', server: { ip, port: 4443, username: 'administrator', password: rdpPass, os: selectedOS.name, region: regionSlug } });
      } else {
        setJob(jobId, { status: 'installing_timeout', step: 'monitor', message: 'RDP belum bisa dikonfirmasi. VPS sudah dibuat; cek beberapa menit lagi atau rebuild.', server: { ip, port: 4443, username: 'administrator', password: rdpPass, os: selectedOS.name, region: regionSlug } });
      }
    } catch (e) {
      console.error('[web] orderRdp provisioning error:', e);
      setJob(jobId, { status: 'failed', step: 'error', message: 'Terjadi kesalahan: ' + (e.message || e) });
    }
  })();

  return { ok: true, jobId };
}

/**
 * Install RDP di VPS yang SUDAH ADA (kredensial manual). Mengembalikan { ok, jobId }.
 */
async function installOnExisting(userId, { ip, sshUser, sshPassword, osVersion, rdpPassword, provider }) {
  const uid = String(userId);
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipRegex.test(String(ip || ''))) return { ok: false, error: 'Format IP tidak valid.' };
  if (!sshPassword) return { ok: false, error: 'Password SSH VPS wajib diisi.' };

  const os = getStandardDedicatedOs().find((o) => o.version === osVersion || String(o.id) === String(osVersion));
  if (!os) return { ok: false, error: 'OS Windows tidak valid.' };

  let rdpPass = rdpPassword;
  if (rdpPass) {
    const chk = validateWindowsPassword(rdpPass);
    if (!chk.ok) return { ok: false, error: chk.error || 'Password RDP tidak valid.' };
  } else {
    rdpPass = genWindowsPassword();
  }

  const installCost = await adminSettings.getNumber('dedicated_install_rdp_cost', DEDICATED_INSTALLATION_COST);
  if (!isAdmin(uid)) {
    const bal = await getBalance(uid);
    const numericBal = typeof bal === 'string' ? 0 : Number(bal);
    if (numericBal < installCost) return { ok: false, error: `Saldo tidak cukup untuk biaya install (Rp ${installCost.toLocaleString('id-ID')}).` };
  }

  // Potong biaya install di awal (mengikuti perilaku bot).
  let charged = false;
  if (!isAdmin(uid) && installCost > 0) {
    const ok = await deductBalance(uid, installCost);
    if (!ok) return { ok: false, error: 'Gagal memotong saldo.' };
    charged = true;
  }

  const jobId = newJob(uid);
  setJob(jobId, { status: 'installing', step: 'installing', message: 'Menginstall Windows RDP...', server: { ip, port: 4443, username: 'administrator', password: rdpPass, os: os.name } });

  (async () => {
    try {
      const sshReady = await waitForPort(ip, 22, 3 * 60 * 1000, 10000);
      if (!sshReady) {
        if (charged) { try { await addBalance(uid, installCost); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'wait_ssh', message: 'Tidak bisa konek SSH ke VPS (port 22). Saldo dikembalikan.' });
        return;
      }
      const installPromise = installDedicatedRDP(ip, sshUser || 'root', sshPassword, { osVersion: os.version, password: rdpPass, provider: provider || 'digitalocean' }, (m) => console.log(`[web-install ${ip}] ${m}`));
      await installPromise;
      const monitor = new RDPMonitor(ip, sshUser || 'root', sshPassword, rdpPass, 4443);
      const result = await monitor.waitForRDPReady(RDP_MONITOR_TIMEOUT_MS, (s) => console.log(`[web-install ${ip}] ${s}`));
      try { monitor.disconnect(); } catch (_) {}
      if (result && result.success && result.rdpReady) {
        setJob(jobId, { status: 'ready', step: 'done', message: 'RDP siap digunakan!', server: { ip, port: 4443, username: 'administrator', password: rdpPass, os: os.name } });
      } else {
        setJob(jobId, { status: 'installing_timeout', step: 'monitor', message: 'RDP belum bisa dikonfirmasi. Cek beberapa menit lagi.', server: { ip, port: 4443, username: 'administrator', password: rdpPass, os: os.name } });
      }
    } catch (e) {
      console.error('[web] installOnExisting error:', e);
      if (charged) { try { await addBalance(uid, installCost); } catch (_) {} }
      setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal install: ' + (e.message || e) + ' (saldo dikembalikan).' });
    }
  })();

  return { ok: true, jobId, installCost };
}

// Daftar RDP milik user (dari vps_instances, difilter RDP).
async function listMyRdp(userId) {
  let rows = [];
  try { rows = await vpsManager.listUserVps(userId); } catch (_) { rows = []; }
  return (rows || [])
    .filter((r) => vpsManager.isRdpInstance(r))
    .map((r) => ({
      id: r.id,
      ip: r.ip,
      server: r.ip ? `${r.ip}:4443` : '-',
      region: r.region || '-',
      os: String(r.image || '').replace(/^rdp:/, ''),
      username: 'administrator',
      password: r.root_password || null,
      expiresAt: r.expires_at || null,
      createdAt: r.created_at || null
    }));
}

function osOptions() {
  return getStandardDedicatedOs().map((o) => ({ id: o.id, name: o.name, version: o.version }));
}

module.exports = {
  listProducts,
  getOrderOptions,
  orderRdp,
  installOnExisting,
  listMyRdp,
  osOptions,
  getJob
};
