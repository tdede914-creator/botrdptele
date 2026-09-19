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
const { getRegions, getSizesForRegion, createDroplet, waitPublicIp, deleteDroplet, isLinodeToken, isAwsToken, isUpCloudToken, linodeSetDirectDisk, rdpPortForToken, makeAwsToken, getAccountEmail } = require('../../src/utils/doApi');
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
function newJob(userId, kind) {
  const id = crypto.randomBytes(9).toString('hex');
  jobs.set(id, { id, userId: String(userId), kind: kind || 'order', status: 'pending', step: 'init', message: 'Menyiapkan...', progress: 2, logs: [], server: null, createdAt: Date.now() });
  // auto-clean setelah 2 jam
  setTimeout(() => jobs.delete(id), 2 * 60 * 60 * 1000).unref?.();
  return id;
}
function setJob(id, patch) { const j = jobs.get(id); if (j) Object.assign(j, patch); }
function pushLog(id, line) {
  const j = jobs.get(id); if (!j) return;
  j.logs = j.logs || [];
  j.logs.push(String(line).replace(/\s+/g, ' ').trim().slice(0, 160));
  if (j.logs.length > 14) j.logs.shift();
}
// Logger fase install: tangkap persentase dari output tele.sh (mis. "... 42%").
function mkInstallLogger(jobId, tag) {
  return (m) => {
    console.log(`[${tag}] ${m}`);
    const j = jobs.get(jobId); if (!j) return;
    pushLog(jobId, m);
    const pm = String(m).match(/(\d{1,3})\s*%/);
    if (pm) {
      const pct = Math.min(100, Number(pm[1]));
      j.progress = Math.max(Number(j.progress) || 0, 35 + Math.round(pct * 0.35)); // 35 -> 70
    }
  };
}
// Logger fase monitoring: "Attempt X/Y" -> progres 70..99.
function mkMonitorLogger(jobId, tag) {
  return (s) => {
    console.log(`[${tag}] ${s}`);
    const j = jobs.get(jobId); if (!j) return;
    pushLog(jobId, s);
    const am = String(s).match(/Attempt\s+(\d+)\/(\d+)/i);
    if (am) {
      const x = Number(am[1]), y = Number(am[2]) || 50;
      j.progress = Math.max(Number(j.progress) || 0, Math.min(99, 70 + Math.round((x / y) * 29)));
      j.message = 'Menunggu Windows boot & RDP siap...';
    }
  };
}
// Akses job berbasis jobId saja (jobId = token acak tak tertebak). Ini memungkinkan
// tamu (tanpa sesi) memantau prosesnya, dan persist saat refresh via localStorage.
function getJob(id) {
  return jobs.get(id) || null;
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

// Biaya jasa install RDP (sama dengan bot: admin_settings dedicated_install_rdp_cost).
async function getInstallCost() {
  return await adminSettings.getNumber('dedicated_install_rdp_cost', DEDICATED_INSTALLATION_COST);
}

// Hitung harga order untuk (produk, durasi) + validasi slot & harga.
async function getOrderAmount(productId, durationDays) {
  const prod = await vpsManager.getProduct(productId);
  if (!prod) return { ok: false, error: 'Produk tidak ditemukan.' };
  const d = Number(durationDays);
  const slotAvail = (d === 1) ? Number(prod.slot_daily || 0) : (d === 7 ? Number(prod.slot_weekly || 0) : Number(prod.slot_monthly || 0));
  if (slotAvail <= 0) return { ok: false, error: 'Slot untuk durasi ini sudah habis.' };
  const price = (d === 1) ? Number(prod.price_daily) : (d === 7 ? Number(prod.price_weekly) : Number(prod.price));
  if (!price) return { ok: false, error: 'Harga untuk durasi ini belum di-set admin.' };
  return { ok: true, amount: price, prod };
}
async function reserveOrderSlot(productId, durationDays) {
  try {
    const dec = await vpsManager.decrementProductSlotDuration(productId, Number(durationDays));
    if (dec && dec.changes === 0) return false;
    return true;
  } catch (_) { return false; }
}
async function releaseOrderSlot(productId, durationDays) {
  try { await vpsManager.incrementProductSlotDuration(productId, Number(durationDays)); } catch (_) {}
}

/**
 * Provision Order RDP. ASUMSI: slot SUDAH direserve & pembayaran SUDAH beres.
 * TIDAK memotong saldo. opts.refund = { uid, amount } untuk mengembalikan saldo
 * bila gagal SEBELUM VPS jadi (hanya untuk pembayar yang login). uid = pemilik
 * (tamu = 0). Mengembalikan { ok, jobId }.
 */
async function provisionOrder(uid, { productId, regionSlug, osId, durationDays, customPassword }, opts = {}) {
  uid = String(uid || 0);
  const d = Number(durationDays);
  const prod = await vpsManager.getProduct(productId);
  if (!prod) { await releaseOrderSlot(productId, d); return { ok: false, error: 'Produk tidak ditemukan.' }; }

  const selectedOS = getStandardDedicatedOs().find((o) => o.id === Number(osId));
  if (!selectedOS) { await releaseOrderSlot(productId, d); return { ok: false, error: 'OS Windows tidak valid.' }; }

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) { await releaseOrderSlot(productId, d); return { ok: false, error: 'API cloud tidak ditemukan.' }; }

  const rdpPass = (customPassword && validateWindowsPassword(customPassword).ok) ? customPassword : genWindowsPassword();
  const rootPass = genAlphaNum(12);
  const cloudInit = rootCloudInit(rootPass);
  const hostname = `rdp-${uid}-${genAlphaNum(6).toLowerCase()}`;
  const refund = (opts.refund && opts.refund.uid) ? opts.refund : null;

  const jobId = newJob(uid, 'order');
  setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Membuat VPS...', progress: 8 });

  // Port RDP per provider (UpCloud 8443, lainnya 4443) + nama provider + base image.
  const rdpPort = rdpPortForToken(token);
  const provider = isAwsToken(token) ? 'aws' : (isLinodeToken(token) ? 'linode' : (isUpCloudToken(token) ? 'upcloud' : 'digitalocean'));

  // Jalankan provisioning async.
  (async () => {
    const createSizeSlug = isAwsToken(token) ? normalizeAwsRdpSize(prod.size_slug) : prod.size_slug;
    const baseImage = isAwsToken(token) ? 'aws:ubuntu22.04'
      : (isLinodeToken(token) ? 'linode/ubuntu22.04'
      : (isUpCloudToken(token) ? 'upcloud/ubuntu22.04' : 'ubuntu-22-04-x64'));
    let dropletId = null;
    let sshKey = null;      // UpCloud: auth pakai private key
    let sshUser = 'root';
    try {
      const created = await createDroplet(token, hostname, regionSlug, createSizeSlug, baseImage, cloudInit);
      dropletId = created.dropletId;
      sshKey = created.sshPrivateKey || null;
      if (created.sshUsername) sshUser = created.sshUsername;
      if (!dropletId) {
        await releaseOrderSlot(productId, d);
        if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'create_vps', message: 'Gagal membuat VPS: ' + (created.error || 'unknown') + (refund ? ' (saldo dikembalikan).' : '') });
        return;
      }

      setJob(jobId, { step: 'wait_ip', message: 'Menunggu IP publik...', progress: 15 });
      const ip = await waitPublicIp(token, dropletId, 20, 10000, regionSlug);
      if (!ip) {
        try { await deleteDroplet(token, dropletId, regionSlug); } catch (_) {}
        await releaseOrderSlot(productId, d);
        if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'wait_ip', message: 'IP VPS belum tersedia. Coba region lain.' + (refund ? ' (saldo dikembalikan).' : '') });
        return;
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const expiresAt = nowSec + (d * 86400);
      try { await require('../../src/utils/userManager').getUser(uid); } catch (_) {} // pastikan baris users ada (FK), termasuk tamu (uid 0)
      await vpsManager.createVpsInstance({
        userId: uid, apiId: prod.api_id, productId: prod.id, dropletId, ip,
        region: regionSlug, image: `rdp:${selectedOS.version}`, rootPassword: rdpPass,
        expiresAt, durationDays: d, rdpPort
      });

      setJob(jobId, { step: 'wait_ssh', message: 'Menunggu SSH siap...', progress: 30, server: { ip, port: rdpPort, username: 'administrator', password: rdpPass, os: selectedOS.name, region: regionSlug } });

      // Order RDP TIDAK di-refund saat gagal — VPS tetap dibuat & bisa di-Rebuild dari
      // menu "VPS/RDP Saya" (refund hanya untuk jasa Install RDP, bukan order).
      const sshReady = await waitForPort(ip, 22, 12 * 60 * 1000, 15000);
      if (!sshReady) {
        setJob(jobId, { status: 'failed', step: 'wait_ssh', message: 'SSH tidak siap. Cek VPS di menu VPS/RDP Saya lalu Rebuild.' });
        return;
      }

      setJob(jobId, { step: 'installing', message: 'Menginstall Windows RDP...', progress: 35 });
      const installCfg = { osVersion: selectedOS.version, password: rdpPass, provider, rdpPort };
      if (sshKey) { installCfg.privateKey = sshKey; if (sshUser !== 'root') installCfg.useSudo = true; }
      const installPromise = installDedicatedRDP(ip, sshUser, rootPass, installCfg, mkInstallLogger(jobId, `web ${ip}`));

      // Linode Direct Disk: jadwal tetap 5/7/9 menit dari saat installer mulai (cara lama
      // yang terbukti bekerja). JANGAN picu pada reboot pertama (SSH putus).
      if (isLinodeToken(token)) {
        const scheduleDD = (minutes) => setTimeout(async () => {
          try { await linodeSetDirectDisk(token, dropletId); console.log(`[web ${ip}] Linode Direct Disk diset (${minutes}m).`); }
          catch (e) { console.warn(`[web ${ip}] DD ${minutes}m`, e.message || e); }
        }, minutes * 60 * 1000);
        [5, 7, 9].forEach(scheduleDD);
      }

      await installPromise;
      setJob(jobId, { step: 'monitor', message: 'Menunggu Windows boot & RDP siap...', progress: 70 });
      const monitor = new RDPMonitor(ip, sshUser, rootPass, rdpPass, rdpPort);
      const result = await monitor.waitForRDPReady(RDP_MONITOR_TIMEOUT_MS, mkMonitorLogger(jobId, `web ${ip}`));
      try { monitor.disconnect(); } catch (_) {}

      if (result && result.success && result.rdpReady) {
        setJob(jobId, { status: 'ready', step: 'done', message: 'RDP siap digunakan!', progress: 100, server: { ip, port: rdpPort, username: 'administrator', password: rdpPass, os: selectedOS.name, region: regionSlug } });
        try { const n = require('./notify'); n.orderSuccess({ event: 'RDP', ip, spec: `RAM ${prod.ram}GB / ${prod.core} CORE`, durationDays: d, apiId: prod.api_id, region: regionSlug, windows: selectedOS.name, buyerId: uid }); n.testimonial({ productName: `RDP ${selectedOS.name}` }); } catch (_) {}
      } else {
        setJob(jobId, { status: 'installing_timeout', step: 'monitor', message: 'RDP belum bisa dikonfirmasi otomatis (monitor timeout). VPS sudah dibuat & Windows kemungkinan sedang boot — coba connect beberapa menit lagi, atau Rebuild dari menu VPS/RDP Saya.', progress: 95, server: { ip, port: rdpPort, username: 'administrator', password: rdpPass, os: selectedOS.name, region: regionSlug } });
      }
    } catch (e) {
      console.error('[web] provisionOrder error:', e);
      setJob(jobId, { status: 'failed', step: 'error', message: 'Terjadi kesalahan: ' + (e.message || e) });
    }
  })();

  return { ok: true, jobId };
}

/**
 * Provision Install RDP di VPS milik user (kredensial manual). ASUMSI: pembayaran
 * sudah beres. TIDAK memotong saldo. opts.refund = { uid, amount } untuk refund bila
 * gagal konek SSH (hanya pembayar login). uid = pemilik (tamu = 0).
 */
async function provisionInstall(uid, { ip, sshUser, sshPassword, osVersion, rdpPassword, provider }, opts = {}) {
  uid = String(uid || 0);
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
  const refund = (opts.refund && opts.refund.uid) ? opts.refund : null;
  // Port RDP: UpCloud 8443, provider lain 4443 (manual install tak punya token, jadi dari pilihan provider user).
  const rdpPort = String(provider || '').toLowerCase() === 'upcloud' ? 8443 : 4443;

  const jobId = newJob(uid, 'install');
  setJob(jobId, { status: 'installing', step: 'wait_ssh', message: 'Menghubungi VPS (SSH)...', progress: 20, server: { ip, port: rdpPort, username: 'administrator', password: rdpPass, os: os.name } });

  (async () => {
    try {
      const sshReady = await waitForPort(ip, 22, 3 * 60 * 1000, 10000);
      if (!sshReady) {
        if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'wait_ssh', message: 'Tidak bisa konek SSH ke VPS (port 22).' + (refund ? ' Saldo dikembalikan.' : '') });
        return;
      }
      setJob(jobId, { step: 'installing', message: 'Menginstall Windows RDP...', progress: 35 });
      const installPromise = installDedicatedRDP(ip, sshUser || 'root', sshPassword, { osVersion: os.version, password: rdpPass, provider: provider || 'digitalocean', rdpPort }, mkInstallLogger(jobId, `web-install ${ip}`));
      await installPromise;
      setJob(jobId, { step: 'monitor', message: 'Menunggu Windows boot & RDP siap...', progress: 70 });
      const monitor = new RDPMonitor(ip, sshUser || 'root', sshPassword, rdpPass, rdpPort);
      const result = await monitor.waitForRDPReady(RDP_MONITOR_TIMEOUT_MS, mkMonitorLogger(jobId, `web-install ${ip}`));
      try { monitor.disconnect(); } catch (_) {}
      if (result && result.success && result.rdpReady) {
        setJob(jobId, { status: 'ready', step: 'done', message: 'RDP siap digunakan!', progress: 100, server: { ip, port: rdpPort, username: 'administrator', password: rdpPass, os: os.name } });
      } else {
        setJob(jobId, { status: 'installing_timeout', step: 'monitor', message: 'RDP belum bisa dikonfirmasi otomatis (monitor timeout). Windows kemungkinan masih boot — coba connect beberapa menit lagi.', progress: 95, server: { ip, port: rdpPort, username: 'administrator', password: rdpPass, os: os.name } });
      }
    } catch (e) {
      console.error('[web] provisionInstall error:', e);
      if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
      setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal install: ' + (e.message || e) + (refund ? ' (saldo dikembalikan).' : '') });
    }
  })();

  return { ok: true, jobId };
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
      server: r.ip ? `${r.ip}:${r.rdp_port || 4443}` : '-',
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

// ============================================================
// Install RDP via API cloud SENDIRI (tanpa kredensial VPS manual).
// User menempel API token cloud-nya (DO/Linode/AWS/UpCloud); sistem membuat
// VPS di akun cloud user lalu install RDP. Bayar hanya biaya jasa install.
// ============================================================
function providerOfToken(token) {
  return isAwsToken(token) ? 'aws' : (isLinodeToken(token) ? 'linode' : (isUpCloudToken(token) ? 'upcloud' : 'digitalocean'));
}
function baseUbuntuForToken(token) {
  return isAwsToken(token) ? 'aws:ubuntu22.04' : (isLinodeToken(token) ? 'linode/ubuntu22.04' : (isUpCloudToken(token) ? 'upcloud/ubuntu22.04' : 'ubuntu-22-04-x64'));
}

// Ubah token mentah yang di-paste user menjadi kandidat token internal doApi.
// Mendukung: UpCloud (ucat_...), AWS (aws:... atau "ACCESS_KEY|SECRET[|REGION]"),
// Linode (linode:... atau PAT mentah), DigitalOcean (token mentah).
// DO & Linode PAT sama-sama hex tanpa prefiks -> ambigu, jadi dicoba DO dulu lalu Linode.
function normalizeCloudTokenCandidates(raw) {
  const t = String(raw || '').trim();
  if (!t) return [];
  if (t.startsWith('ucat_')) return [{ provider: 'upcloud', token: t }];
  if (t.startsWith('aws:')) return [{ provider: 'aws', token: t }];
  if (t.startsWith('linode:')) return [{ provider: 'linode', token: t }];
  // AWS mentah: "AKIA.../ASIA... | SECRET [| REGION]" (pemisah | atau :)
  const awsRaw = t.match(/^((?:AKIA|ASIA)[A-Z0-9]{8,})\s*[|:]\s*([^|:\s]+)(?:\s*[|:]\s*([A-Za-z0-9-]+))?$/i);
  if (awsRaw) return [{ provider: 'aws', token: makeAwsToken(awsRaw[1], awsRaw[2], awsRaw[3] || 'us-east-1') }];
  if (t.includes('|')) {
    const p = t.split('|').map((x) => x.trim());
    if (p.length >= 2 && p[0] && p[1]) return [{ provider: 'aws', token: makeAwsToken(p[0], p[1], p[2] || 'us-east-1') }];
  }
  // Ambigu: DigitalOcean atau Linode. Coba DO dulu, lalu Linode.
  return [{ provider: 'digitalocean', token: t }, { provider: 'linode', token: 'linode:' + t }];
}

// Validasi token + daftar region yang tersedia di akun cloud user.
// Mengembalikan juga `token` (bentuk internal ternormalisasi) yang HARUS dipakai
// frontend untuk request berikutnya (sizes + order) agar provider terdeteksi benar.
async function listApiRegions(apiToken) {
  const candidates = normalizeCloudTokenCandidates(apiToken);
  if (!candidates.length) return { ok: false, error: 'API token cloud wajib diisi.' };
  let lastErr = 'Token tidak valid.';
  for (const c of candidates) {
    try {
      // AWS: daftar region bersifat statis (tak butuh auth). Verifikasi kredensial
      // via getAccountEmail bersifat best-effort saja — JANGAN tolak kalau gagal,
      // karena banyak access key EC2 tidak punya izin IAM untuk baca info akun.
      // Kredensial yang salah akan ketahuan (dan gagal) saat pembuatan VPS.
      const regions = await getRegions(c.token);
      if (regions && regions.length) {
        return { ok: true, provider: c.provider, token: c.token, regions: regions.slice(0, 80).map((r) => ({ slug: r.slug, name: r.name || r.slug })) };
      }
      lastErr = 'Token valid tapi tidak ada region tersedia.';
    } catch (e) {
      lastErr = (e && e.response && e.response.data && e.response.data.message) || (e && e.message) || String(e);
    }
  }
  return { ok: false, error: 'Token API tidak valid / gagal terhubung ke cloud: ' + lastErr };
}

// Daftar spesifikasi (size) untuk token + region.
async function listApiSizes(apiToken, regionSlug) {
  const token = String(apiToken || '').trim();
  if (!token) return { ok: false, error: 'API token cloud wajib diisi.' };
  if (!regionSlug) return { ok: false, error: 'Region wajib dipilih.' };
  try {
    const sizes = await getSizesForRegion(token, regionSlug);
    const list = (sizes || []).map((s) => {
      const memMb = Number(s.memory || 0);
      const mem = memMb ? `${memMb >= 1024 ? Math.round(memMb / 1024) + 'GB' : memMb + 'MB'} RAM` : (s.ram ? `${s.ram}GB RAM` : '');
      const cpu = s.vcpus ? `${s.vcpus} vCPU` : (s.cores ? `${s.cores} vCPU` : '');
      const spec = [mem, cpu].filter(Boolean).join(' / ');
      const label = spec ? `${s.slug} — ${spec}` : String(s.slug);
      return { slug: s.slug, label };
    }).filter((s) => s.slug);
    if (!list.length) return { ok: false, error: 'Tidak ada spesifikasi tersedia untuk region ini.' };
    return { ok: true, sizes: list.slice(0, 120) };
  } catch (e) {
    return { ok: false, error: 'Gagal memuat spesifikasi: ' + ((e && e.message) || e) };
  }
}

/**
 * Provision Install RDP memakai API cloud SENDIRI. ASUMSI: pembayaran (biaya jasa
 * install) sudah beres; TIDAK memotong saldo. opts.refund untuk refund bila gagal
 * SEBELUM VPS jadi (hanya pembayar login). uid = pemilik (tamu = 0).
 */
async function provisionInstallOwnApi(uid, { apiToken, regionSlug, sizeSlug, osVersion, rdpPassword }, opts = {}) {
  uid = String(uid || 0);
  const token = String(apiToken || '').trim();
  if (!token) return { ok: false, error: 'API token cloud wajib diisi.' };
  if (!regionSlug) return { ok: false, error: 'Region wajib dipilih.' };
  if (!sizeSlug) return { ok: false, error: 'Spesifikasi (size) wajib dipilih.' };
  const selectedOS = getStandardDedicatedOs().find((o) => o.version === osVersion || String(o.id) === String(osVersion));
  if (!selectedOS) return { ok: false, error: 'OS Windows tidak valid.' };
  let rdpPass = rdpPassword;
  if (rdpPass) { const chk = validateWindowsPassword(rdpPass); if (!chk.ok) return { ok: false, error: chk.error || 'Password RDP tidak valid.' }; }
  else rdpPass = genWindowsPassword();

  const refund = (opts.refund && opts.refund.uid) ? opts.refund : null;
  const rootPass = genAlphaNum(12);
  const cloudInit = rootCloudInit(rootPass);
  const hostname = `rdp-${uid}-${genAlphaNum(6).toLowerCase()}`;
  const rdpPort = rdpPortForToken(token);
  const provider = providerOfToken(token);

  const jobId = newJob(uid, 'install');
  setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Membuat VPS di akun cloud kamu...', progress: 8 });

  (async () => {
    const createSizeSlug = isAwsToken(token) ? normalizeAwsRdpSize(sizeSlug) : sizeSlug;
    const baseImage = baseUbuntuForToken(token);
    let dropletId = null; let sshKey = null; let sshUser = 'root';
    try {
      const created = await createDroplet(token, hostname, regionSlug, createSizeSlug, baseImage, cloudInit);
      dropletId = created.dropletId; sshKey = created.sshPrivateKey || null; if (created.sshUsername) sshUser = created.sshUsername;
      if (!dropletId) {
        if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'create_vps', message: 'Gagal membuat VPS: ' + (created.error || 'unknown') + (refund ? ' (saldo dikembalikan).' : '') });
        return;
      }
      setJob(jobId, { step: 'wait_ip', message: 'Menunggu IP publik...', progress: 15 });
      const ip = await waitPublicIp(token, dropletId, 20, 10000, regionSlug);
      if (!ip) {
        try { await deleteDroplet(token, dropletId, regionSlug); } catch (_) {}
        if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'wait_ip', message: 'IP VPS belum tersedia. Coba region lain.' + (refund ? ' (saldo dikembalikan).' : '') });
        return;
      }
      setJob(jobId, { step: 'wait_ssh', message: 'Menunggu SSH siap...', progress: 30, server: { ip, port: rdpPort, username: 'administrator', password: rdpPass, os: selectedOS.name, region: regionSlug } });
      const sshReady = await waitForPort(ip, 22, 12 * 60 * 1000, 15000);
      if (!sshReady) {
        if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'wait_ssh', message: 'SSH tidak siap di VPS akun cloud kamu.' + (refund ? ' Biaya install dikembalikan.' : '') });
        return;
      }

      setJob(jobId, { step: 'installing', message: 'Menginstall Windows RDP...', progress: 35 });
      const installCfg = { osVersion: selectedOS.version, password: rdpPass, provider, rdpPort };
      if (sshKey) { installCfg.privateKey = sshKey; if (sshUser !== 'root') installCfg.useSudo = true; }
      const installPromise = installDedicatedRDP(ip, sshUser, sshKey ? null : rootPass, installCfg, mkInstallLogger(jobId, `web-ownapi ${ip}`));

      if (isLinodeToken(token)) {
        const scheduleDD = (minutes) => setTimeout(async () => {
          try { await linodeSetDirectDisk(token, dropletId); console.log(`[web-ownapi ${ip}] Linode Direct Disk diset (${minutes}m).`); }
          catch (e) { console.warn(`[web-ownapi ${ip}] DD ${minutes}m`, e.message || e); }
        }, minutes * 60 * 1000);
        [5, 7, 9].forEach(scheduleDD);
      }

      await installPromise;
      setJob(jobId, { step: 'monitor', message: 'Menunggu Windows boot & RDP siap...', progress: 70 });
      const monitor = new RDPMonitor(ip, sshUser, rootPass, rdpPass, rdpPort);
      const result = await monitor.waitForRDPReady(RDP_MONITOR_TIMEOUT_MS, mkMonitorLogger(jobId, `web-ownapi ${ip}`));
      try { monitor.disconnect(); } catch (_) {}
      const server = { ip, port: rdpPort, username: 'administrator', password: rdpPass, os: selectedOS.name, region: regionSlug };
      if (result && result.success && result.rdpReady) {
        setJob(jobId, { status: 'ready', step: 'done', message: 'RDP siap digunakan!', progress: 100, server });
      } else {
        if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'monitor', message: 'RDP tidak online dalam ' + Math.round(RDP_MONITOR_TIMEOUT_MS / 60000) + ' menit — dianggap gagal.' + (refund ? ' Biaya install dikembalikan.' : '') + ' VPS bare-Ubuntu tetap ada di akun cloud kamu.', progress: 100, server });
      }
    } catch (e) {
      console.error('[web] provisionInstallOwnApi error:', e);
      if (refund) { try { await addBalance(refund.uid, refund.amount); } catch (_) {} }
      setJob(jobId, { status: 'failed', step: 'error', message: 'Gagal install: ' + (e.message || e) + (refund ? ' (saldo dikembalikan).' : '') });
    }
  })();

  return { ok: true, jobId };
}

// Bungkus "prepare" seragam untuk lapisan checkout (saldo vs QRIS + refund).
async function prepareOrder(params) {
  const amt = await getOrderAmount(params.productId, params.durationDays);
  if (!amt.ok) return amt;
  return {
    ok: true,
    amount: amt.amount,
    reserve: () => reserveOrderSlot(params.productId, params.durationDays),
    release: () => releaseOrderSlot(params.productId, params.durationDays),
    provision: (uid, opts) => provisionOrder(uid, params, opts)
  };
}
// Install RDP di web = KHUSUS pakai API token cloud sendiri (bukan kredensial VPS manual).
async function prepareInstall(params) {
  const v = validateInstallParams(params);
  if (!v.ok) return v;
  const amount = await getInstallCost();
  return { ok: true, amount, provision: (uid, opts) => provisionInstallOwnApi(uid, params, opts) };
}

// Validasi input install (API-cloud-sendiri) sebelum minta bayar supaya user tak bayar untuk input invalid.
function validateInstallParams({ apiToken, regionSlug, sizeSlug, osVersion, rdpPassword }) {
  if (!String(apiToken || '').trim()) return { ok: false, error: 'API token cloud wajib diisi.' };
  if (!regionSlug) return { ok: false, error: 'Region wajib dipilih.' };
  if (!sizeSlug) return { ok: false, error: 'Spesifikasi (size) wajib dipilih.' };
  const os = getStandardDedicatedOs().find((o) => o.version === osVersion || String(o.id) === String(osVersion));
  if (!os) return { ok: false, error: 'OS Windows tidak valid.' };
  if (rdpPassword) { const chk = validateWindowsPassword(rdpPassword); if (!chk.ok) return { ok: false, error: chk.error || 'Password RDP tidak valid.' }; }
  return { ok: true };
}

module.exports = {
  listProducts,
  getOrderOptions,
  getOrderAmount,
  reserveOrderSlot,
  releaseOrderSlot,
  provisionOrder,
  getInstallCost,
  provisionInstall,
  provisionInstallOwnApi,
  listApiRegions,
  listApiSizes,
  listMyRdp,
  osOptions,
  validateInstallParams,
  prepareOrder,
  prepareInstall,
  getJob,
  // helper bersama dipakai service lain (vps/cloud9/fastpanel)
  _shared: { newJob, setJob, mkInstallLogger, mkMonitorLogger, pushLog, genAlphaNum, genWindowsPassword, rootCloudInit, normalizeAwsRdpSize, waitForPort }
};
