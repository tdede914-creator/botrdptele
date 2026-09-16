const crypto = require('crypto');
const net = require('net');
const { isAdmin, getBalance, deductBalance } = require('../utils/userManager');
const { getRegions, createDroplet, waitPublicIp, deleteDroplet, isLinodeToken, isAwsToken, linodeSetDirectDisk } = require('../utils/doApi');
const vpsManager = require('../utils/vpsManager');
const { notifyOrderSuccess, notifyOrderTestimonial } = require('../utils/orderNotifier');
const safeMessageEditor = require('../utils/safeMessageEdit');
const { DEDICATED_OS_VERSIONS } = require('../config/constants');
const {
  RDP_MONITOR_TIMEOUT_MS,
  buildTimeoutCardMarkdown,
  buildTimeoutCardKeyboard
} = require('../utils/rdpPasswordUtil');
const { installDedicatedRDP } = require('../utils/dedicatedRdpInstaller');
const RDPMonitor = require('../utils/rdpMonitor');

function genAlphaNum(n = 18) {
  // Strong enough for Linode root_pass: 11-128 chars, upper/lower/digit/symbol.
  const raw = crypto.randomBytes(48).toString('base64').replace(/[\/+=]/g, '');
  const body = raw.slice(0, Math.max(12, Number(n) || 18));
  return `${body}-KCSERVER-143`;
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
  - [ sh, -lc, "set -e; (grep -q '^PermitRootLogin' /etc/ssh/sshd_config && sed -i 's/^PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config); (grep -q '^PasswordAuthentication' /etc/ssh/sshd_config && sed -i 's/^PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config); (grep -q '^KbdInteractiveAuthentication' /etc/ssh/sshd_config && sed -i 's/^KbdInteractiveAuthentication.*/KbdInteractiveAuthentication yes/' /etc/ssh/sshd_config || echo 'KbdInteractiveAuthentication yes' >> /etc/ssh/sshd_config); systemctl restart ssh || systemctl restart sshd || service ssh restart || true" ]
`;
}

function genWindowsPassword() {
  // Must contain letter and number, min 10 chars to be safe
  for (let i = 0; i < 50; i++) {
    const p = genAlphaNum(14);
    if (/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{10,}$/.test(p)) return p;
  }
  // Fallback
  return `Win${Date.now()}A1`;
}

function normalizeAwsRdpSize(sizeSlug) {
  const size = String(sizeSlug || '');
  const map = {
    't3.micro': 't2.micro',
    't3.small': 't2.small',
    't3.medium': 't2.medium',
    't3.large': 't2.large',
    't3.xlarge': 't2.xlarge',
    'm5.large': 't2.large',
    'm5.xlarge': 't2.xlarge'
  };
  return map[size] || size;
}


async function waitForPort(host, port, totalMs = 12 * 60 * 1000, intervalMs = 15000) {
  const start = Date.now();
  const tryOnce = () => new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(5000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });

  while (Date.now() - start < totalMs) {
    const ok = await tryOnce();
    if (ok) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function getStandardDedicatedOs() {
  return (DEDICATED_OS_VERSIONS || []).filter(os =>
    os && typeof os.version === 'string' &&
    !os.version.includes('lite') &&
    !os.version.includes('uefi') &&
    os.version !== 'win_10atlas' &&
    os.version !== 'win_2025'
  );
}


// NOTE: product aggregation is handled in vpsManager.listActiveProductGroups() using SQL GROUP BY.



async function showProducts(bot, chatId, messageId) {
  const products = await vpsManager.listActiveProductGroups('rdp');

  if (!products.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '❌ Produk VPS kosong.\n\nHubungi admin untuk menambahkan produk.',
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]] } }
    );
  }

  // Step 1: user memilih spesifikasi saja (tanpa info durasi/harga/stok)
  // Info durasi/harga/stok akan ditampilkan pada step berikutnya (pemilihan durasi).
  const kb = products.map(p => ([
    {
      text: `RAM ${Number(p.ram)}GB / ${Number(p.core)} CORE`,
      callback_data: `rdp_buygrp:${Number(p.ram)}:${Number(p.core)}`
    }
  ]));
  kb.push([{ text: '« Kembali', callback_data: 'vps_rdp_menu' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🖥️ *ORDER RDP (Auto Create + Auto Install)*\n\nPilih paket VPS untuk RDP:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
  );
}



async function pickProduct(bot, chatId, messageId, ram, core) {
  const group = (await vpsManager.listActiveProductGroups('rdp')).find(g => Number(g.ram) === Number(ram) && Number(g.core) === Number(core));
  if (!group) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Produk tidak ditemukan atau slot habis. Silakan pilih ulang dari daftar terbaru.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'order_rdp' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
    });
  }

  const kb = [];
  if (group.price_daily != null && Number(group.slot_daily || 0) > 0) {
    kb.push([{ text: `🗓️ Harian • Rp${Number(group.price_daily).toLocaleString()} (stok ${Number(group.slot_daily || 0)})`, callback_data: `rdp_buydur:${ram}:${core}:1` }]);
  }
  if (group.price_weekly != null && Number(group.slot_weekly || 0) > 0) {
    kb.push([{ text: `🗓️ Mingguan (7 hari) • Rp${Number(group.price_weekly).toLocaleString()} (stok ${Number(group.slot_weekly || 0)})`, callback_data: `rdp_buydur:${ram}:${core}:7` }]);
  }
  if (group.price_monthly != null && Number(group.slot_monthly || 0) > 0) {
    kb.push([{ text: `🗓️ Bulanan (30 hari) • Rp${Number(group.price_monthly).toLocaleString()} (stok ${Number(group.slot_monthly || 0)})`, callback_data: `rdp_buydur:${ram}:${core}:30` }]);
  }
  kb.push([{ text: '« Kembali', callback_data: 'order_rdp' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ *Pilih Durasi RDP*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}


function providerButtonLabel(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'aws') return '🟠 Provider AWS';
  if (p === 'linode') return '🟣 Provider Linode';
  return '🌊 Provider DigitalOcean';
}

async function pickProviderByDuration(bot, chatId, messageId, ram, core, durationDays = 7) {
  const providers = await vpsManager.listActiveProductProviders('rdp', ram, core, durationDays);
  if (!providers.length) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Produk tidak ditemukan atau slot habis untuk durasi ini.', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'order_rdp' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
  });
  const kb = providers.map(p => ([{ text: `${providerButtonLabel(p.provider)} • Rp${Number(p.price || 0).toLocaleString('id-ID')} • Stok ${Number(p.slot || 0)}`, callback_data: `rdp_buyprov:${ram}:${core}:${durationDays}:${p.provider}` }]));
  kb.push([{ text: '« Kembali', callback_data: `rdp_buygrp:${ram}:${core}` }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, '☁️ *Pilih Provider RDP*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

async function pickProductByProvider(bot, chatId, messageId, ram, core, durationDays = 7, provider = 'all') {
  const prod = await vpsManager.getAvailableProductBySpecDurationProvider('rdp', ram, core, durationDays, provider);
  if (!prod) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Produk/provider tidak ditemukan atau slot habis.', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: `rdp_buydur:${ram}:${core}:${durationDays}` }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
  });
  return pickProductById(bot, chatId, messageId, prod.id, durationDays);
}

async function pickProductByDuration(bot, chatId, messageId, ram, core, durationDays = 7) {
  // Pick the API/product row with the most available slot for this spec + duration price availability
  const prod = await vpsManager.getAvailableProductBySpecDuration('rdp', ram, core, durationDays);
  if (!prod) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Produk tidak ditemukan atau slot habis. Silakan pilih ulang dari daftar terbaru.', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'order_rdp' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
  });

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return bot.sendMessage(chatId, '❌ API cloud tidak ditemukan. Hubungi admin.');

  const regions = await getRegions(token);
  if (!regions.length) return bot.sendMessage(chatId, '❌ Tidak ada region tersedia.');

  const kb = regions.slice(0, 40).map(r => ([{
    text: `${r.slug} (${r.name})`,
    callback_data: `rdp_reg:${prod.id}:${r.slug}:${durationDays}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'order_rdp' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '🌍 *Pilih Region RDP*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function pickRegion(bot, chatId, messageId, productId, regionSlug, durationDays = 7) {
  const prod = await vpsManager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return bot.sendMessage(chatId, '❌ API cloud tidak ditemukan. Hubungi admin.');

  // Hanya tampilkan Windows standard (tanpa Atlas/Lite/UEFI/2025)
  const osList = getStandardDedicatedOs();
  const kb = osList.map(o => ([{
    text: o.name,
    callback_data: `rdp_os:${productId}:${regionSlug}:${o.id}:${durationDays}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'order_rdp' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '🪟 *Pilih Windows untuk RDP*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

/**
 * Between OS pick and VPS provisioning, ask the user how they want
 * their Windows password set. See processCustomOrderPasswordInput for
 * the text-input side of the wizard.
 */
async function askOrderPasswordMode(bot, chatId, messageId, productId, regionSlug, osId, durationDays = 7) {
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🔐 *Password RDP*\n\n' +
    'Pilih cara set password Windows:\n\n' +
    '• *Auto* — bot generate password random (recommended, aman).\n' +
    '• *Custom* — kamu ketik password sendiri (min 8 char, huruf+angka).',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎲 Auto (Recommended)', callback_data: `rdp_pass_auto:${productId}:${regionSlug}:${osId}:${durationDays}` }],
          [{ text: '🔐 Custom Password', callback_data: `rdp_pass_custom:${productId}:${regionSlug}:${osId}:${durationDays}` }],
          [{ text: '« Ganti Windows', callback_data: `rdp_reg:${productId}:${regionSlug}:${durationDays}` }]
        ]
      }
    }
  );
}

async function startOrderCustomPasswordInput(bot, chatId, messageId, productId, regionSlug, osId, durationDays, sessionManager) {
  sessionManager.setUserSession(chatId, {
    installType: 'order_rdp_custom_password',
    step: 'waiting_password',
    productId, regionSlug, osId, durationDays,
    messageId
  });
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🔐 *Ketik Password RDP*\n\n' +
    'Kirim password sebagai balasan pesan ini.\n\n' +
    '📋 *Aturan password:*\n' +
    '• 8-30 karakter\n' +
    '• Tidak boleh ada spasi\n' +
    '• Kombinasi min 2 dari: huruf besar (A-Z), huruf kecil (a-z), angka (0-9)\n' +
    '• Tidak boleh: ` " \\\\ \' & | < > % $\n\n' +
    'Contoh valid: `Renter2024`, `MyRDP123`',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `rdp_os:${productId}:${regionSlug}:${osId}:${durationDays}` }]] }
    }
  );
}

async function processOrderCustomPasswordInput(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getUserSession(chatId);
  if (!session) return false;
  if (session.installType !== 'order_rdp_custom_password') return false;
  if (session.step !== 'waiting_password') return false;

  const rawPassword = String(msg.text || '').trim();
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}

  const { validateWindowsPassword } = require('../utils/rdpPasswordUtil');
  const check = validateWindowsPassword(rawPassword);
  if (!check.ok) {
    await bot.sendMessage(chatId,
      `❌ ${check.error}\n\nKirim ulang password, atau tekan Batal.`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `rdp_os:${session.productId}:${session.regionSlug}:${session.osId}:${session.durationDays}` }]] } }
    );
    return true;
  }

  const { productId, regionSlug, osId, durationDays, messageId } = session;
  sessionManager.clearUserSession(chatId);

  await createRdp(bot, chatId, messageId, productId, regionSlug, osId, durationDays, { customPassword: rawPassword });
  return true;
}

async function createRdp(bot, chatId, messageId, productId, regionSlug, osId, durationDays = 7, opts = {}) {
  const uid = chatId;

  const prod = await vpsManager.getProduct(productId);
  if (!prod) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Produk tidak ditemukan atau slot habis. Silakan pilih ulang dari daftar terbaru.', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'order_rdp' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
  });

  // Double-check slot untuk durasi yang dipilih
  const d = Number(durationDays);
  const slotAvail = (d === 1) ? Number(prod.slot_daily || 0) : (d === 7 ? Number(prod.slot_weekly || 0) : Number(prod.slot_monthly || 0));
  if (slotAvail <= 0) return bot.sendMessage(chatId, '❌ Slot untuk durasi ini sudah habis.');

  const osList = getStandardDedicatedOs();
  const selectedOS = osList.find(o => o.id === osId);
  if (!selectedOS) return bot.sendMessage(chatId, '❌ OS tidak valid.');

  const basePrice = (d === 1)
    ? Number(prod.price_daily)
    : (d === 7 ? Number(prod.price_weekly) : Number(prod.price));
  if (!basePrice) return bot.sendMessage(chatId, '❌ Harga untuk durasi ini belum di-set oleh admin.');
  const totalCost = basePrice; // biaya sudah termasuk OS

  // Check balance (admin unlimited)
  if (!isAdmin(uid)) {
    const bal = await getBalance(uid);
    const numericBal = typeof bal === 'string' ? 0 : Number(bal);
    if (numericBal < totalCost) {
      return bot.sendMessage(chatId, `❌ Saldo tidak cukup.\nButuh: Rp ${totalCost.toLocaleString()} (VPS + Install RDP)`);
    }
  }

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return bot.sendMessage(chatId, '❌ API cloud tidak ditemukan.');

  const rootPass = genAlphaNum(12);
  // Custom password if the user opted in via the wizard, else auto-generate.
  // Guard: re-validate at use time so a bad session state can't slip in.
  const { validateWindowsPassword } = require('../utils/rdpPasswordUtil');
  const rdpPass = (opts?.customPassword && validateWindowsPassword(opts.customPassword).ok)
    ? opts.customPassword
    : genWindowsPassword();

  const cloudInit = rootCloudInit(rootPass);

  await safeMessageEditor.editMessage(bot, chatId, messageId,
    '⏳ VPS untuk RDP sedang dibuat, mohon tunggu...\n\n' +
    `📌 Paket: RAM ${Number(prod.ram)}GB / ${Number(prod.core)} CORE\n` +
    `📌 Region: ${regionSlug}\n` +
    `💿 Windows: ${selectedOS.name}\n` +
    `💰 Total: Rp ${totalCost.toLocaleString()}`,
    { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] } }
  );

  const hostname = `rdp-${uid}-${genAlphaNum(6).toLowerCase()}`;

  // Reserve slot dulu (biar tidak oversell). Kalau nanti gagal create droplet, slot akan dikembalikan.
  try {
    await vpsManager.decrementProductSlotDuration(productId, d);
  } catch (e) {
    return bot.sendMessage(chatId, '❌ Slot untuk durasi ini sudah habis.');
  }

  // AWS RDP harus disamakan dengan flow renter yang sudah berhasil.
  // t3/m5 sering boot NVMe/UEFI (disk nvme0n1) dan image Windows gagal/timeout.
  // Renter memakai t2 sehingga disk menjadi xvda dan install RDP berjalan stabil.
  const createSizeSlug = isAwsToken(token) ? normalizeAwsRdpSize(prod.size_slug) : prod.size_slug;

  const { dropletId, error } = await createDroplet(
    token,
    hostname,
    regionSlug,
    createSizeSlug,
    isAwsToken(token) ? 'aws:ubuntu22.04' : (isLinodeToken(token) ? 'linode/ubuntu22.04' : 'ubuntu-22-04-x64'),
    cloudInit
  );

  if (!dropletId) {
    // release slot
    try { await vpsManager.incrementProductSlotDuration(productId, d); } catch (_) {}
    console.error('Create VPS for RDP failed:', error);
    const detail = isAdmin(uid) && error ? `\nAlasan create VPS: ${String(error).slice(0, 180)}` : '';
    return bot.sendMessage(chatId, `❌ Instalasi RDP gagal, VPS belum berhasil dibuat sehingga belum masuk menu VPS&RDP Saya.${detail}`);
  }

  const ip = await waitPublicIp(token, dropletId, 20, 10000, regionSlug);
  if (!ip) {
    await deleteDroplet(token, dropletId, regionSlug);
    // release reserved slot because provisioning did not complete
    try { await vpsManager.incrementProductSlotDuration(productId, d); } catch (_) {}
    return bot.sendMessage(chatId, '❌ Instalasi RDP gagal, IP VPS belum tersedia sehingga belum masuk menu VPS&RDP Saya. Silahkan coba region lain.');
  }

  // Jangan set Direct Disk sebelum installer berjalan.
  // Untuk Linode, Ubuntu awal perlu tetap boot via GRUB agar tele.sh bisa masuk ke Alpine installer.
  // Direct Disk akan diset otomatis beberapa menit setelah installer dimulai, supaya boot berikutnya masuk Windows.

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + (Number(durationDays) * 86400);

  await vpsManager.createVpsInstance({
    userId: uid,
    apiId: prod.api_id,
    productId: prod.id,
    dropletId,
    ip,
    region: regionSlug,
    image: `rdp:${selectedOS.version}`,
    // Untuk RDP, simpan password Windows agar menu backup/restore bisa SSH ke OpenSSH Windows.
    // rootPass Linux hanya dipakai sementara saat proses installer berjalan.
    rootPassword: rdpPass,
    expiresAt,
    durationDays: Number(durationDays)
  });

  // Deduct balance only. Slot was already reserved before provisioning started.
  if (!isAdmin(uid)) await deductBalance(uid, totalCost);

  // Start install process (background-ish with monitoring)
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    '🚀 Memulai instalasi Windows RDP otomatis...\n\n' +
    `🌐 IP: ${ip}\n` +
    `💿 Windows: ${selectedOS.name}\n` +
    `🔒 Port RDP: 4443\n\n` +
    '⏰ Estimasi maksimal 15 menit.\n' +
    '🔔 Kamu akan dapat notifikasi saat RDP siap.',
    { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] } }
  );

  (async () => {
    try {
      // Wait for SSH to be ready (droplet booting can take time)
      const sshReady = await waitForPort(ip, 22, 12 * 60 * 1000, 15000);
      if (!sshReady) {
        await bot.sendMessage(chatId, '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.');
        return;
      }

      const installPromise = installDedicatedRDP(ip, 'root', rootPass, {
        osVersion: selectedOS.version,
        password: rdpPass,
        provider: isAwsToken(token) ? 'aws' : (isLinodeToken(token) ? 'linode' : 'digitalocean')
      }, (logMessage) => console.log(`[${ip}] ${logMessage}`));

      // Linode: setelah tele.sh memicu boot Alpine, kernel harus diganti ke Direct Disk
      // SEBELUM Alpine selesai menulis Windows dan reboot lagi. Jika terlambat, Linode berhenti di prompt grub>.
      if (isLinodeToken(token)) {
        const scheduleLinodeDirectDisk = (minutes) => setTimeout(async () => {
          try {
            const dd = await linodeSetDirectDisk(token, dropletId);
            if (!dd.ok) console.warn(`[${ip}] Gagal set Linode Direct Disk (${minutes}m):`, dd.error);
            else console.log(`[${ip}] Linode Direct Disk diset otomatis (${minutes}m) untuk boot Windows.`);
          } catch (e) {
            console.warn(`[${ip}] Gagal set Linode Direct Disk (${minutes}m):`, e.message || e);
          }
        }, minutes * 60 * 1000);

        // 5 menit biasanya sudah cukup untuk tele.sh reboot ke Alpine, tapi masih sebelum reboot Windows.
        // Diulang beberapa kali agar tetap aman kalau API Linode sedang lambat.
        [5, 7, 9].forEach(scheduleLinodeDirectDisk);
      }

      const monitor = new RDPMonitor(ip, 'root', rootPass, rdpPass, 4443);

      // Update message after a short delay then wait for RDP readiness
      setTimeout(async () => {
        try {
          await safeMessageEditor.editMessage(bot, chatId, messageId,
            '⚙️ Instalasi Windows sedang berjalan...\n\n' +
            `🌐 IP: ${ip}\n` +
            `💿 Windows: ${selectedOS.name}\n` +
            `🔒 Port RDP: 4443\n\n` +
            '🔍 Status: Menunggu Windows boot dan RDP siap...\n' +
            '📌 Catatan: Proses berjalan otomatis, mohon tunggu.'
          );

          await installPromise;
          const rdpResult = await monitor.waitForRDPReady(RDP_MONITOR_TIMEOUT_MS, (s) => console.log(`[${ip}] ${s}`));
          monitor.disconnect();

          if (rdpResult.success && rdpResult.rdpReady) {
// Status message
await safeMessageEditor.editMessage(
  bot,
  chatId,
  messageId,
  `✅ INSTALL RDP SELESAI!\n\n` +
    `🌐 Server: ${ip}:4443\n` +
    `👤 Username: administrator\n` +
    `🔑 Password: ${rdpPass}\n\n` +
    `⏰ Waktu Instalasi: ${rdpResult.totalTime || 'N/A'} menit\n` +
    `⚡ Response Time: ${rdpResult.responseTime || 'N/A'}ms\n\n` +
    `🚀 STATUS: SIAP DIGUNAKAN SEKARANG!`,
  {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Copy Detail RDP', callback_data: `copy_rdp_${ip}_${rdpPass}_${hostname}` }],
        [{ text: '📖 Panduan Koneksi', callback_data: 'rdp_connection_guide' }],
        [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
      ]
    }
  }
);

// Detail message (sama seperti install RDP)
await bot.sendMessage(
  chatId,
  `🎉 Detail Akun RDP Windows - SIAP PAKAI\n\n` +
    `🏷️ Hostname: ${hostname}\n` +
	    `📍 Region: ${regionSlug}\n` +
	    `🪟 Windows: ${selectedOS.name}\n` +
    `🌐 Server: ${ip}:4443\n` +
    `👤 Username: administrator\n` +
    `🔑 Password: ${rdpPass}\n` +
    `⚡ Response Time: ${rdpResult.responseTime || 'N/A'}ms\n\n` +
    `📖 Cara Koneksi RDP:\n` +
    `1️⃣ Buka Remote Desktop Connection\n` +
    `2️⃣ Masukkan: ${ip}:4443\n` +
    `3️⃣ Username: administrator\n` +
    `4️⃣ Password: ${rdpPass}\n` +
    `5️⃣ Connect dan enjoy!\n\n` +
    `💡 Tips Penting:\n` +
    `⚠️ No detect Abuse, Ddos, Exploit Dsb!\n` +
    `⚠️ Support proxy(VPN NOT RECOMMENDED)\n` +
    `⚠️ Jika data sangat penting, mohon rutin backup!!!\n` +
    `⏰ Waktu instalasi: ${rdpResult.totalTime || 'N/A'} menit\n\n` +
    `🚀 Server telah diverifikasi dan 100% ready!`,
  {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Copy Server', callback_data: `copy_server_${ip}:4443` }],
        [{ text: '📋 Copy Username', callback_data: 'copy_username_administrator' }],
        [{ text: '📋 Copy Password', callback_data: `copy_pass_${rdpPass}` }],
        [{ text: '📖 Panduan Koneksi', callback_data: 'rdp_connection_guide' }],
        [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
      ]
    }
  }
);

		            await notifyOrderSuccess(bot, {
	              event: 'ORDER',
              type: 'RDP',
              ip: `${ip}:4443`,
              spec: `${prod.ram || ''}GB / ${prod.core || ''} CORE (${prod.size_slug})`.replace(/^GB \/  CORE /, '').trim(),
              apiId: prod.api_id,
	              durationDays: Number(durationDays),
		              price: (Number(durationDays) === 1 ? prod.price_daily : (Number(durationDays) === 7 ? prod.price_weekly : prod.price)),
		              region: regionSlug,
		              windows: selectedOS.name,
              buyerId: uid
            });

		            // Channel #2 (testimoni) - minimal, optional
		            await notifyOrderTestimonial(bot, { productName: 'RDP' });

} else {
            // BUGFIX: on monitor timeout, still hand the user their password.
            // Rebuild is now a last resort — often the RDP just needs a few
            // more minutes and works fine on a manual connect attempt.
            // Password was already saved to DB during createVpsInstance() above.
            await safeMessageEditor.editMessage(bot, chatId, messageId,
              buildTimeoutCardMarkdown({
                ip, port: 4443, hostname, osName: selectedOS.name,
                region: regionSlug, password: rdpPass,
                elapsedMin: rdpResult.totalTime || Math.round(RDP_MONITOR_TIMEOUT_MS / 60000)
              }),
              {
                parse_mode: 'Markdown',
                reply_markup: buildTimeoutCardKeyboard({ ip, port: 4443, password: rdpPass })
              }
            );
          }
        } catch (e) {
          console.error('RDP monitor error:', e);
        }
      }, 15000);

      // Avoid unhandled rejection if install fails quickly
      installPromise.catch(async (err) => {
        console.error('Install error:', err);
        await bot.sendMessage(chatId, '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.');
      });

    } catch (err) {
      console.error('Order RDP error:', err);
      await bot.sendMessage(chatId, '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.');
    }
  })();
}


// Backward compatibility: old callback payloads used productId
async function pickProductById(bot, chatId, messageId, productId, durationDays = 7) {
  const prod = await vpsManager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return bot.sendMessage(chatId, '❌ API cloud tidak ditemukan. Hubungi admin.');

  const regions = await getRegions(token);
  if (!regions.length) return bot.sendMessage(chatId, '❌ Tidak ada region tersedia.');

  const kb = regions.slice(0, 40).map(r => ([{
    text: `${r.slug} (${r.name})`,
    callback_data: `rdp_reg:${productId}:${r.slug}:${durationDays}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: `rdp_buydur:${prod.ram}:${prod.core}:${durationDays}` }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '🌍 *Pilih Region RDP*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function pickRegionById(bot, chatId, messageId, productId, regionSlug, durationDays = 7) {
  return pickRegion(bot, chatId, messageId, productId, regionSlug, durationDays);
}

async function createRdpById(bot, chatId, messageId, productId, regionSlug, osId, durationDays = 7) {
  return createRdp(bot, chatId, messageId, productId, regionSlug, osId, durationDays);
}

module.exports = {
  showProducts,
  // New grouped flow
  pickProduct,
  pickProviderByDuration,
  pickProductByProvider,
  pickProductByDuration,
  pickRegion,
  createRdp,
  // Custom-password wizard
  askOrderPasswordMode,
  startOrderCustomPasswordInput,
  processOrderCustomPasswordInput,
  // Backward-compat
  pickProductById,
  pickRegionById,
  createRdpById
};
