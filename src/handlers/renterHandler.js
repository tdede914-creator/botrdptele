const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Client } = require('ssh2');
const renterManager = require('../utils/renterManager');
const safeMessageEditor = require('../utils/safeMessageEdit');
const menuBanner = require('../utils/menuBanner');
const { getSizesForRegion, getRegions, getImages, createDroplet, waitPublicIp, deleteDroplet, isLinodeToken, isAwsToken, isUpCloudToken, providerName, linodeSetDirectDisk, rdpPortForToken } = require('../utils/doApi');
const { DEDICATED_OS_VERSIONS } = require('../config/constants');
const { installDedicatedRDP } = require('../utils/dedicatedRdpInstaller');
const RDPMonitor = require('../utils/rdpMonitor');
const rdpPasswordUtil = require('../utils/rdpPasswordUtil');
const QRCode = require('qrcode');
const { createPayment, checkPaymentStatus, isPaymentStatusSuccessful } = require('../utils/payment');
const { getBalance, deductBalance, addBalance } = require('../utils/userManager');
const { notifyRentOrderSuccess, notifyOrderTestimonial } = require('../utils/orderNotifier');
const { pack: cbPack } = require('../utils/cbToken');

// -------------------------------------------------------------------------
// Sizes cache
// -------------------------------------------------------------------------
// Panggilan `getSizesForRegion()` untuk Linode akan fetch SEMUA linode types
// (paginated) tiap panggilan — 1-3 detik per call. Tanpa cache, klik tombol
// pagination "Next" akan re-fetch, dan kalau slow/rate-limited, user melihat
// bot "diam". Cache per (chatId + region + apiId) dengan TTL 5 menit.
const sizesCache = new Map();
const SIZES_CACHE_TTL_MS = 5 * 60 * 1000;

function _sizesCacheKey(chatId, region, apiId) {
  return `${chatId}_${region}_${apiId}`;
}

function getCachedSizes(chatId, region, apiId) {
  const entry = sizesCache.get(_sizesCacheKey(chatId, region, apiId));
  if (!entry) return null;
  if (Date.now() - entry.at > SIZES_CACHE_TTL_MS) {
    sizesCache.delete(_sizesCacheKey(chatId, region, apiId));
    return null;
  }
  return entry.sizes;
}

function setCachedSizes(chatId, region, apiId, sizes) {
  sizesCache.set(_sizesCacheKey(chatId, region, apiId), { sizes, at: Date.now() });
}

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
  for (let i = 0; i < 50; i++) {
    const p = genAlphaNum(14);
    if (/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{10,}$/.test(p)) return p;
  }
  return `Win${Date.now()}A1`;
}

function apiLabel(api) {
  const byKey = {
    linode: 'Linode',
    aws: 'AWS',
    upcloud: 'UpCloud',
    digitalocean: 'DigitalOcean',
  };
  const provider = api.provider || byKey[api.provider_key] || 'DigitalOcean';
  return `${provider} API#${api.id} • ${api.email || '-'}`;
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


function scheduleLinodeDirectDiskIfNeeded(token, dropletId, ip) {
  if (!isLinodeToken(token) || !dropletId) return;
  const run = (minutes) => setTimeout(async () => {
    try {
      const dd = await linodeSetDirectDisk(token, dropletId);
      if (!dd.ok) console.warn(`[RENTER ${ip}] Gagal set Linode Direct Disk (${minutes}m):`, dd.error);
      else console.log(`[RENTER ${ip}] Linode Direct Disk diset otomatis (${minutes}m) untuk boot Windows.`);
    } catch (e) {
      console.warn(`[RENTER ${ip}] Gagal set Linode Direct Disk (${minutes}m):`, e.message || e);
    }
  }, minutes * 60 * 1000);
  [5, 7, 9].forEach(run);
}

async function waitForPort(host, port, totalMs = 12 * 60 * 1000, intervalMs = 15000) {
  const start = Date.now();
  const tryOnce = () => new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
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

function getWindowsList() {
  return (DEDICATED_OS_VERSIONS || []).filter(os =>
    os && typeof os.version === 'string' &&
    !os.version.includes('lite') &&
    !os.version.includes('uefi') &&
    os.version !== 'win_10atlas' &&
    os.version !== 'win_2025'
  );
}


async function sendRenterVpsReady(bot, chatId, data) {
  const { ip, password, image, region, sizeSlug, provider } = data;
  const isUpCloud = String(provider || '').toLowerCase() === 'upcloud';
  const tipLine = isUpCloud
    ? `\n💡 Kalau SSH \`Connection refused\` / \`timeout\`, tunggu 1-2 menit\n   lalu coba lagi (cloud-init masih finalize).\n`
    : '';
  return bot.sendMessage(chatId,
    `━━━ VPS BERHASIL DIBUAT ━━━\n` +
    `📝 IP       : ${ip}\n` +
    `📝 USER     : root\n` +
    `📝 PASSWORD : ${password}\n` +
    `📝 OS       : ${image}\n` +
    `📝 REGION   : ${region}\n` +
    `📝 SIZE     : ${sizeSlug}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ Simpan data ini baik-baik.\n` +
    `⚠️ Biaya resource mengikuti tagihan ${provider || 'cloud provider'} kamu sendiri.\n` +
    tipLine +
    `\nKetik /start untuk kembali ke menu.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 Copy IP', callback_data: `copy_server_${ip}` }],
          [{ text: '📋 Copy Password', callback_data: `copy_pass_${password}` }],
          [{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]
        ]
      }
    }
  );
}

async function sendRenterRdpReadyMessages(bot, chatId, messageId, data) {
  const {
    ip,
    hostname,
    rdpPass,
    windowsName,
    region,
    sizeSlug,
    responseTime = 'N/A',
    totalTime = 'N/A',
    ready = true,
    port = 4443
  } = data;

  if (!ready) {
    // BUGFIX: previously we sent only the "gagal, rebuild" text on
    // monitor timeout and dropped the freshly-generated password. Users
    // whose RDP eventually came up (Linode non-SGP is notorious for
    // this) had no way to know their credentials. Now we hand them the
    // full connection card with a "try before rebuild" nudge.
    const timeoutText = rdpPasswordUtil.buildTimeoutCardMarkdown({
      ip, port, hostname, osName: windowsName, region,
      password: rdpPass, elapsedMin: totalTime
    });
    const timeoutKb = rdpPasswordUtil.buildTimeoutCardKeyboard({ ip, port, password: rdpPass });
    if (messageId) {
      try {
        await safeMessageEditor.editMessage(bot, chatId, messageId, timeoutText, {
          parse_mode: 'Markdown',
          reply_markup: timeoutKb
        });
      } catch (_) { /* fallthrough to sendMessage below */ }
    }
    return bot.sendMessage(chatId, timeoutText, {
      parse_mode: 'Markdown',
      reply_markup: timeoutKb
    });
  }

  if (messageId) {
    await safeMessageEditor.editMessage(bot, chatId, messageId,
      `${ready ? '✅ INSTALL RDP SELESAI!' : '✅ Instalasi sudah diproses, namun RDP belum terdeteksi siap.'}

` +
      `🌐 Server: ${ip}:${port}
` +
      `👤 Username: administrator
` +
      `🔑 Password: ${rdpPass}

` +
      `⏰ Waktu Instalasi: ${totalTime} menit
` +
      `⚡ Response Time: ${responseTime}ms

` +
      `${ready ? '🚀 STATUS: SIAP DIGUNAKAN SEKARANG!' : '⏳ Silakan tunggu beberapa menit lalu coba konek.'}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📋 Copy Detail RDP', callback_data: `copy_rdp_${ip}:${port}_${rdpPass}` }],
            [{ text: '📖 Panduan Koneksi', callback_data: 'rdp_connection_guide' }],
            [{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]
          ]
        }
      }
    );
  }

  return bot.sendMessage(chatId,
    `🎉 Detail Akun RDP Windows - SIAP PAKAI

` +
    `🏷️ Hostname: ${hostname || '-'}
` +
    `📍 Region: ${region || '-'}
` +
    `🪟 Windows: ${windowsName || '-'}
` +
    `📦 Size: ${sizeSlug || '-'}
` +
    `🌐 Server: ${ip}:${port}
` +
    `👤 Username: administrator
` +
    `🔑 Password: ${rdpPass}
` +
    `⚡ Response Time: ${responseTime}ms

` +
    `📖 Cara Koneksi RDP:
` +
    `1️⃣ Buka Remote Desktop Connection
` +
    `2️⃣ Masukkan: ${ip}:${port}
` +
    `3️⃣ Username: administrator
` +
    `4️⃣ Password: ${rdpPass}
` +
    `5️⃣ Connect dan enjoy!

` +
    `💡 Tips Penting:
` +
    `⚠️ No detect Abuse, Ddos, Exploit Dsb!
` +
    `⚠️ Support proxy(VPN NOT RECOMMENDED)
` +
    `⚠️ Jika data sangat penting, mohon rutin backup!!!
` +
    `⏰ Waktu instalasi: ${totalTime} menit

` +
    `🚀 Server telah diverifikasi dan 100% ready!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 Copy Server', callback_data: `copy_server_${ip}:${port}` }],
          [{ text: '📋 Copy Username', callback_data: 'copy_username_administrator' }],
          [{ text: '📋 Copy Password', callback_data: `copy_pass_${rdpPass}` }],
          [{ text: '📖 Panduan Koneksi', callback_data: 'rdp_connection_guide' }],
          [{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]
        ]
      }
    }
  );
}

async function requireRenter(bot, chatId, messageId) {
  const active = await renterManager.isActiveRenter(chatId);
  if (!active) {
    await showRentOffer(bot, chatId, messageId);
    return false;
  }
  return true;
}

function formatRp(n) {
  return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
}

function getPlanMeta(plan, prices) {
  const p = String(plan || '').toLowerCase();
  if (p === 'daily') return { plan: 'daily', label: 'Harian', days: 1, price: Number(prices.daily || 0) };
  if (p === 'weekly') return { plan: 'weekly', label: 'Mingguan', days: 7, price: Number(prices.weekly || 0) };
  if (p === 'monthly') return { plan: 'monthly', label: 'Bulanan', days: 30, price: Number(prices.monthly || 0) };
  return null;
}

async function notifyRentActivated(bot, payload) {
  try {
    await notifyRentOrderSuccess(bot, payload);
    await notifyOrderTestimonial(bot, { productName: 'SEWA BOT' });
  } catch (e) {
    console.error('Rent order notification error:', e?.message || e);
  }
}

async function generateQrBuffer(qrString) {
  try {
    return await QRCode.toBuffer(qrString, { type: 'png', width: 400, margin: 2 });
  } catch (e) {
    console.error('Renter QR generate error:', e.message);
    return null;
  }
}

async function showRentOffer(bot, chatId, messageId) {
  const { basic, premium } = await renterManager.getAllTierPrices();
  const monthlyUsers = await renterManager.countMonthlyRenters();

  const text =
    `🔐 *SEWA BOT — KOBONG CLOUD SERVER*\n\n` +
    `👥 Penyewa aktif bulan ini: *${monthlyUsers} pengguna*\n\n` +
    `Pilih paket sewa yang sesuai kebutuhan kamu.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🥈 *RENTER BASIC*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Cocok untuk yang butuh VPS & RDP unlimited pakai API cloud sendiri.\n\n` +
    `✅ Install RDP Gratis (jasa install ke VPS kamu)\n` +
    `✅ Buat VPS Linux unlimited (via API kamu)\n` +
    `✅ Buat RDP Windows unlimited (via API kamu)\n` +
    `✅ Manajemen API DigitalOcean / Linode / AWS\n` +
    `✅ Backup & Restore data renter\n` +
    `❌ Tidak termasuk Cloud9\n` +
    `❌ Tidak termasuk Fastpanel\n\n` +
    `💰 Harian:   *${formatRp(basic.daily)}*\n` +
    `💰 Mingguan: *${formatRp(basic.weekly)}*\n` +
    `💰 Bulanan:  *${formatRp(basic.monthly)}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🥇 *RENTER PREMIUM* ✨\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Semua fitur Basic, plus akses eksklusif Cloud9 & Fastpanel.\n\n` +
    `✅ Semua fitur *Basic* di atas\n` +
    `✨ Install *Cloud9 IDE* (jasa install ke VPS kamu)\n` +
    `✨ Buat *Cloud9 IDE* (auto via API kamu)\n` +
    `✨ Install *Fastpanel* (jasa install ke VPS kamu)\n` +
    `✨ Buat *Fastpanel* (auto via API kamu)\n\n` +
    `💰 Harian:   *${formatRp(premium.daily)}*\n` +
    `💰 Mingguan: *${formatRp(premium.weekly)}*\n` +
    `💰 Bulanan:  *${formatRp(premium.monthly)}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💡 Jika saldo cukup, sewa langsung aktif. Kalau sebagian, QRIS dibuat untuk kekurangannya.`;

  return menuBanner.showMenu(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: `🥈 BASIC HARIAN - ${formatRp(basic.daily)}`, callback_data: 'rent_buy:basic:daily' }],
      [{ text: `🥈 BASIC MINGGUAN - ${formatRp(basic.weekly)}`, callback_data: 'rent_buy:basic:weekly' }],
      [{ text: `🥈 BASIC BULANAN - ${formatRp(basic.monthly)}`, callback_data: 'rent_buy:basic:monthly' }],
      [{ text: `🥇 PREMIUM HARIAN - ${formatRp(premium.daily)}`, callback_data: 'rent_buy:premium:daily' }],
      [{ text: `🥇 PREMIUM MINGGUAN - ${formatRp(premium.weekly)}`, callback_data: 'rent_buy:premium:weekly' }],
      [{ text: `🥇 PREMIUM BULANAN - ${formatRp(premium.monthly)}`, callback_data: 'rent_buy:premium:monthly' }],
      [{ text: '🏠 Menu User', callback_data: 'renter_user_menu' }]
    ] }
  });
}

async function startRentPurchase(bot, chatId, messageId, plan, tier = 'basic', username = null) {
  // Active renter buying premium = upgrade path (allowed). Active premium
  // renter buying premium/basic = just extend expiry.
  const currentTier = await renterManager.getRenterTier(chatId);
  const purchaseTier = renterManager.normalizeTier(tier);
  if (currentTier === 'premium' && purchaseTier === 'basic') {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      `❌ Kamu sudah paket *Premium*. Kalau mau perpanjang, beli paket *Premium* lagi (bukan Basic).`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🥇 Beli Premium', callback_data: 'renter_upgrade_premium' }], [{ text: '« Kembali', callback_data: 'renter_menu' }]] } }
    );
  }

  try {
    const expired = await renterManager.cleanupExpiredRentPayments();
    for (const p of expired || []) {
      if (Number(p.user_id) === Number(chatId)) {
        await renterManager.markRentPaymentStatus(p.transaction_id, 'expired');
        if (Number(p.balance_used) > 0) await addBalance(chatId, Number(p.balance_used));
      }
    }
  } catch (_) {}
  const pending = await renterManager.getPendingRentPayment(chatId);
  if (pending) {
    const pendingTier = renterManager.normalizeTier(pending.tier);
    const pendingTierLabel = pendingTier === 'premium' ? 'Premium' : 'Basic';
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      `💳 Kamu masih memiliki tagihan sewa bot pending.\n\nTier: *${pendingTierLabel}*\nPaket: ${pending.plan}\nTotal harga: ${formatRp(pending.price)}\nKekurangan QRIS: ${formatRp(pending.amount)}\n\nSilakan bayar tagihan sebelumnya atau batalkan dulu.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh Status', callback_data: `rent_pay_refresh:${pending.transaction_id}` }], [{ text: '❌ Batalkan', callback_data: `rent_pay_cancel:${pending.transaction_id}` }], [{ text: '« Kembali', callback_data: 'renter_menu' }]] } }
    );
  }
  const prices = await renterManager.getRentPrices(purchaseTier);
  const meta = getPlanMeta(plan, prices);
  if (!meta || meta.price <= 0) return bot.sendMessage(chatId, '❌ Paket sewa tidak valid.');
  const tierLabel = purchaseTier === 'premium' ? 'Premium' : 'Basic';

  const balanceRaw = await getBalance(chatId);
  const balance = typeof balanceRaw === 'number' ? Number(balanceRaw) : 0;
  if (balance >= meta.price) {
    const ok = await deductBalance(chatId, meta.price);
    if (!ok) return bot.sendMessage(chatId, '❌ Saldo tidak cukup.');
    const res = await renterManager.addRenter(chatId, meta.days, purchaseTier, username);
    await notifyRentActivated(bot, { userId: chatId, username, tier: res.tier, tierLabel, plan: meta.plan, planLabel: meta.label, days: meta.days, price: meta.price, method: 'Saldo', expiresAt: renterManager.formatDate(res.expiresAt) });
    await bot.sendMessage(chatId, `✅ Sewa bot aktif!\nTier: *${res.tier === 'premium' ? 'Premium 🥇' : 'Basic 🥈'}*\nPaket: ${meta.label}\nAktif sampai: ${renterManager.formatDate(res.expiresAt)}`, { parse_mode: 'Markdown' });
    return showRenterMenu(bot, chatId, messageId);
  }

  const balanceUsed = Math.max(0, Math.min(balance, meta.price));
  const amountToPay = meta.price - balanceUsed;
  if (balanceUsed > 0) {
    const ok = await deductBalance(chatId, balanceUsed);
    if (!ok) return bot.sendMessage(chatId, '❌ Gagal menggunakan saldo. Silakan coba lagi.');
  }

  await safeMessageEditor.editMessage(bot, chatId, messageId, `⏳ Membuat QRIS pembayaran sewa bot *${tierLabel}*...`, { parse_mode: 'Markdown' });
  try {
    const uniqueCode = `RENT${Date.now()}${chatId}`;
    const payment = await createPayment(process.env.DOMPETX_API_KEY, uniqueCode, amountToPay);
    if (!payment.success || !payment.data || (!payment.data.qr_string && !payment.data.qr_image && !payment.data.payment_url)) throw new Error(payment.error || 'QRIS tidak tersedia');
    const expiryTime = payment.data.expired_at ? new Date(payment.data.expired_at).getTime() : Date.now() + (30 * 60 * 1000);
    await renterManager.addPendingRentPayment({
      userId: chatId,
      transactionId: payment.data.id,
      uniqueCode: payment.data.reff_id || uniqueCode,
      plan: meta.plan,
      days: meta.days,
      price: meta.price,
      amount: amountToPay,
      balanceUsed,
      expiryTime,
      tier: purchaseTier
    });

    const tierEmoji = purchaseTier === 'premium' ? '🥇' : '🥈';
    const text = `💳 *Pembayaran Sewa Bot ${tierEmoji} ${tierLabel}*\n\n` +
      `📦 Paket: *${meta.label}* (${meta.days} hari)\n` +
      `💰 Harga: *${formatRp(meta.price)}*\n` +
      `👛 Saldo dipakai: *${formatRp(balanceUsed)}*\n` +
      `📌 Kekurangan via QRIS: *${formatRp(amountToPay)}*\n\n` +
      `Scan QRIS di atas. Setelah pembayaran berhasil, sewa bot otomatis aktif.`;
    const qrBuffer = payment.data.qr_string ? await generateQrBuffer(payment.data.qr_string) : null;
    try { await bot.deleteMessage(chatId, messageId); } catch (_) {}
    let sent;
    const payUrl = payment.data.payment_url || payment.data.qr_image || null;
    const rows = [];
    if (payUrl) rows.push([{ text: '💳 Bayar Sekarang (QRIS)', url: payUrl }]);
    rows.push([{ text: '🔄 Refresh Status', callback_data: `rent_pay_refresh:${payment.data.id}` }]);
    rows.push([{ text: '❌ Batalkan', callback_data: `rent_pay_cancel:${payment.data.id}` }]);
    const reply_markup = { inline_keyboard: rows };
    if (qrBuffer) sent = await bot.sendPhoto(chatId, qrBuffer, { caption: text, parse_mode: 'Markdown', reply_markup });
    else sent = await bot.sendMessage(chatId, text + (payUrl ? '\n\n👉 Tekan *Bayar Sekarang (QRIS)* untuk membuka halaman pembayaran.' : ''), { parse_mode: 'Markdown', reply_markup });
    startRentPaymentPolling(bot, chatId, sent.message_id, payment.data.id);
  } catch (e) {
    if (balanceUsed > 0) { try { await addBalance(chatId, balanceUsed); } catch (_) {} }
    console.error('Rent payment creation error:', e);
    await bot.sendMessage(chatId, '❌ Gagal membuat QRIS sewa bot. Silakan coba lagi.');
  }
}

async function completeRentPayment(bot, chatId, messageId, transactionId) {
  const pending = await renterManager.getRentPaymentByTransaction(transactionId);
  if (!pending || pending.status !== 'pending') return false;
  await renterManager.markRentPaymentStatus(transactionId, 'paid');
  const tier = renterManager.normalizeTier(pending.tier);
  const tierLabel = tier === 'premium' ? 'Premium 🥇' : 'Basic 🥈';
  const res = await renterManager.addRenter(pending.user_id, pending.days, tier, null);
  const planLabel = pending.plan === 'daily' ? 'Harian' : pending.plan === 'weekly' ? 'Mingguan' : pending.plan === 'monthly' ? 'Bulanan' : pending.plan;
  await notifyRentActivated(bot, { userId: pending.user_id, username: null, tier: res.tier, tierLabel, plan: pending.plan, planLabel, days: pending.days, price: pending.price, method: Number(pending.balance_used) > 0 ? 'Saldo + QRIS' : 'QRIS', expiresAt: renterManager.formatDate(res.expiresAt) });
  await bot.sendMessage(pending.user_id, `✅ Pembayaran berhasil. Sewa bot kamu sudah aktif!\nTier: *${tierLabel}*\nPaket: ${planLabel}\nAktif sampai: ${renterManager.formatDate(res.expiresAt)}`, { parse_mode: 'Markdown' });
  try { await safeMessageEditor.editMessage(bot, pending.user_id, messageId, '✅ Pembayaran sewa bot berhasil. Menu renter sudah aktif.', { reply_markup: { inline_keyboard: [[{ text: '🔐 Menu Renter', callback_data: 'renter_menu' }]] } }); } catch (_) {}
  return true;
}

async function refreshRentPayment(bot, chatId, messageId, transactionId) {
  const pending = await renterManager.getRentPaymentByTransaction(transactionId);
  if (!pending || Number(pending.user_id) !== Number(chatId) || pending.status !== 'pending') {
    return bot.sendMessage(chatId, '❌ Tagihan sewa tidak ditemukan / sudah selesai.');
  }
  const status = await checkPaymentStatus(process.env.DOMPETX_API_KEY, transactionId);
  if (status.success && isPaymentStatusSuccessful(status.data)) {
    return completeRentPayment(bot, chatId, messageId, transactionId);
  }
  return bot.sendMessage(chatId, '⏳ Pembayaran belum diterima. Silakan refresh lagi setelah membayar.');
}

async function cancelRentPayment(bot, chatId, messageId, transactionId) {
  const pending = await renterManager.getRentPaymentByTransaction(transactionId);
  if (!pending || Number(pending.user_id) !== Number(chatId) || pending.status !== 'pending') {
    return bot.sendMessage(chatId, '❌ Tagihan sewa tidak ditemukan / sudah selesai.');
  }
  await renterManager.markRentPaymentStatus(transactionId, 'cancelled');
  if (Number(pending.balance_used) > 0) await addBalance(chatId, Number(pending.balance_used));
  return safeMessageEditor.editMessage(bot, chatId, messageId, '✅ Pembayaran sewa dibatalkan. Saldo yang sempat dipakai sudah dikembalikan.', { reply_markup: { inline_keyboard: [[{ text: '🔐 Sewa Bot', callback_data: 'renter_menu' }], [{ text: '🏠 Menu User', callback_data: 'renter_user_menu' }]] } });
}

function startRentPaymentPolling(bot, chatId, messageId, transactionId) {
  let checks = 0;
  const timer = setInterval(async () => {
    checks += 1;
    try {
      const pending = await renterManager.getRentPaymentByTransaction(transactionId);
      if (!pending || pending.status !== 'pending') return clearInterval(timer);
      if (Date.now() > Number(pending.expiry_time)) {
        await renterManager.markRentPaymentStatus(transactionId, 'expired');
        if (Number(pending.balance_used) > 0) await addBalance(chatId, Number(pending.balance_used));
        await bot.sendMessage(chatId, '⏰ Tagihan sewa bot expired. Saldo yang sempat dipakai sudah dikembalikan.');
        return clearInterval(timer);
      }
      const status = await checkPaymentStatus(process.env.DOMPETX_API_KEY, transactionId);
      if (status.success && isPaymentStatusSuccessful(status.data)) {
        await completeRentPayment(bot, chatId, messageId, transactionId);
        return clearInterval(timer);
      }
      if (checks >= 90) clearInterval(timer);
    } catch (e) {
      console.error('Rent payment polling error:', e.message);
      if (checks >= 90) clearInterval(timer);
    }
  }, 20000);
}

async function showStartChoice(bot, chatId, messageId = null, firstName = 'User') {
  const text =
    `╔══════════════════════════════════╗\n` +
    `   🌐  *KOBONG CLOUD SERVER*  🌐\n` +
    `     _One-Stop Cloud Solutions_\n` +
    `╚══════════════════════════════════╝\n\n` +
    `👋 Halo, *${firstName}*!\n\n` +
    `Silakan pilih tipe akses kamu di bawah ⬇️`;
  const opts = {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '👤 MENU USER', callback_data: 'renter_user_menu' }],
      [{ text: '🔐 MENU RENTER', callback_data: 'renter_menu' }]
    ] }
  };
  return menuBanner.showMenu(bot, chatId, messageId, text, opts);
}

async function showRenterMenu(bot, chatId, messageId) {
  if (!await renterManager.isActiveRenter(chatId)) return showRentOffer(bot, chatId, messageId);
  const renter = await renterManager.getRenter(chatId);
  const tier = renterManager.normalizeTier(renter.tier);
  const isPremium = tier === 'premium';
  const monthlyUsers = await renterManager.countMonthlyRenters();

  const tierLabel = isPremium ? '🥇 *MENU RENTER PREMIUM* ✨' : '🥈 *MENU RENTER BASIC*';
  const tierNote = isPremium
    ? `Kamu punya akses ke *semua fitur*, termasuk Cloud9 & Fastpanel.`
    : `Kamu di paket Basic. Upgrade ke Premium untuk akses Cloud9 & Fastpanel.`;

  const text = `${tierLabel}\n\n` +
    `👥 Penyewa aktif bulan ini: *${monthlyUsers} pengguna*\n` +
    `🆔 User ID: \`${chatId}\`\n` +
    `📅 Aktif sampai: ${renterManager.formatDate(renter.expires_at)}\n\n` +
    `${tierNote}\n\n` +
    `Pilih layanan renter di bawah ⬇️`;

  // Base buttons — available to both tiers.
  const kb = [
    [{ text: '🖥️ Install RDP Gratis', callback_data: 'renter_install_rdp' }],
    [{ text: '🖥️ Buat VPS', callback_data: 'renter_vps_start' }],
    [{ text: '🪟 Buat RDP', callback_data: 'renter_rdp_start' }]
  ];

  if (isPremium) {
    // Premium-exclusive rows: 2 columns for Cloud9 (install + create) and Fastpanel.
    kb.push([
      { text: '☁️ Install Cloud9', callback_data: 'renter_c9_install' },
      { text: '☁️ Buat Cloud9', callback_data: 'renter_c9_create' }
    ]);
    kb.push([
      { text: '⚡ Install Fastpanel', callback_data: 'renter_fp_install' },
      { text: '⚡ Buat Fastpanel', callback_data: 'renter_fp_create' }
    ]);
  } else {
    kb.push([{ text: '⬆️ Upgrade ke Premium', callback_data: 'renter_upgrade_premium' }]);
  }

  kb.push([{ text: '🔑 API Cloud', callback_data: 'renter_api_menu' }]);
  kb.push([{ text: '🗂️ VPS&RDP Saya', callback_data: 'renter_services' }]);
  kb.push([{ text: 'ℹ️ Info Renter', callback_data: 'renter_info' }]);
  kb.push([{ text: '🏠 Menu Utama', callback_data: 'renter_main_choice' }]);

  return menuBanner.showMenu(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

/**
 * Show the upgrade page for Basic renters who want to jump to Premium.
 * Charges the FULL premium price (no proration) but the remaining days on
 * the basic subscription are preserved — user gets the premium tier applied
 * to their current expiry window plus whatever plan they now buy.
 */
async function showUpgradeOffer(bot, chatId, messageId) {
  if (!await renterManager.isActiveRenter(chatId)) return showRentOffer(bot, chatId, messageId);
  const renter = await renterManager.getRenter(chatId);
  if (renterManager.normalizeTier(renter.tier) === 'premium') return showRenterMenu(bot, chatId, messageId);

  const { premium } = await renterManager.getAllTierPrices();
  const text = `⬆️ *UPGRADE KE RENTER PREMIUM*\n\n` +
    `Kamu saat ini paket Basic (aktif sampai ${renterManager.formatDate(renter.expires_at)}).\n\n` +
    `Dengan upgrade ke *Premium*, kamu dapat semua fitur Basic *plus*:\n` +
    `✨ Install & Buat *Cloud9 IDE* (via API kamu)\n` +
    `✨ Install & Buat *Fastpanel* (via API kamu)\n\n` +
    `Beli paket Premium di bawah — tier akan langsung naik ke Premium dan\n` +
    `masa aktif diperpanjang sesuai durasi yang kamu pilih.\n\n` +
    `💰 Harian:   *${formatRp(premium.daily)}*\n` +
    `💰 Mingguan: *${formatRp(premium.weekly)}*\n` +
    `💰 Bulanan:  *${formatRp(premium.monthly)}*`;

  return safeMessageEditor.editMessage(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: `🥇 PREMIUM HARIAN - ${formatRp(premium.daily)}`, callback_data: 'rent_buy:premium:daily' }],
      [{ text: `🥇 PREMIUM MINGGUAN - ${formatRp(premium.weekly)}`, callback_data: 'rent_buy:premium:weekly' }],
      [{ text: `🥇 PREMIUM BULANAN - ${formatRp(premium.monthly)}`, callback_data: 'rent_buy:premium:monthly' }],
      [{ text: '« Kembali', callback_data: 'renter_menu' }]
    ] }
  });
}

/**
 * Guard: block a callback if the renter is not premium. Shows an upgrade CTA.
 */
async function requirePremiumRenter(bot, chatId, messageId) {
  if (!await requireRenter(bot, chatId, messageId)) return false;
  if (await renterManager.isPremiumRenter(chatId)) return true;
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `🔒 Fitur ini khusus *Renter Premium*.\n\nUpgrade paket kamu untuk akses Cloud9 & Fastpanel.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '⬆️ Upgrade ke Premium', callback_data: 'renter_upgrade_premium' }],
      [{ text: '« Kembali', callback_data: 'renter_menu' }]
    ] } });
  return false;
}

async function showApiMenu(bot, chatId, messageId) {
  if (!await requireRenter(bot, chatId, messageId)) return;
  const apis = await renterManager.listApis(chatId);
  const lines = apis.length
    ? apis.map(a => `${a.provider || 'DigitalOcean'} API#${a.id} • ${a.email || '-'} • ${Number(a.status) === 1 ? 'Aktif' : 'Nonaktif'}`).join('\n')
    : 'Belum ada API cloud. Tambahkan API DigitalOcean, Linode, AWS, atau UpCloud.';
  return safeMessageEditor.editMessage(bot, chatId, messageId, `🔑 *API Cloud Renter*\n\n${lines}`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '➕ Tambah API DigitalOcean', callback_data: 'renter_api_add' }],
      [{ text: '➕ Tambah API Linode', callback_data: 'renter_api_add_linode' }],
      [{ text: '➕ Tambah API AWS', callback_data: 'renter_api_add_aws' }],
      [{ text: '➕ Tambah API UpCloud', callback_data: 'renter_api_add_upcloud' }],
      [{ text: '🗑️ Delete API', callback_data: 'renter_api_delete_menu' }, { text: '⛔ Nonaktifkan API', callback_data: 'renter_api_disable_menu' }],
      [{ text: '« Kembali', callback_data: 'renter_menu' }]
    ] }
  });
}

async function promptAddApi(bot, chatId, messageId, sessionManager, provider = 'digitalocean') {
  if (!await requireRenter(bot, chatId, messageId)) return;
  const p = String(provider || 'digitalocean').toLowerCase();
  const label =
    p === 'aws' ? 'AWS'
    : p === 'linode' ? 'Linode'
    : p === 'upcloud' ? 'UpCloud'
    : 'DigitalOcean';
  sessionManager.setAdminSession(chatId, { action: 'renter_add_api', provider: p, messageId });
  let extra = '';
  if (p === 'aws') {
    extra = '\n\nFormat AWS:\n`ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION`\nContoh: `AKIAxxxx|secretxxxx|us-east-1`';
  } else if (p === 'upcloud') {
    extra = '\n\nBuat token di https://hub.upcloud.com/account/api-tokens\nToken diawali `ucat_`. Set allowed IPs = `0.0.0.0/0` supaya bot bisa akses.';
  }
  return safeMessageEditor.editMessage(bot, chatId, messageId, `🔑 Masukkan token/API ${label} kamu:${extra}\n\nToken akan dihapus dari chat setelah dikirim.`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'renter_api_menu' }]] }
  });
}

async function showApiPick(bot, chatId, messageId, mode) {
  if (!await requireRenter(bot, chatId, messageId)) return;
  const apis = await renterManager.listApis(chatId, mode === 'use');
  if (!apis.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Belum ada API aktif. Tambahkan API DigitalOcean/Linode/AWS/UpCloud terlebih dahulu.', {
      reply_markup: { inline_keyboard: [[{ text: '➕ API DO', callback_data: 'renter_api_add' }, { text: '➕ API Linode', callback_data: 'renter_api_add_linode' }], [{ text: '➕ API AWS', callback_data: 'renter_api_add_aws' }, { text: '➕ API UpCloud', callback_data: 'renter_api_add_upcloud' }], [{ text: '« Kembali', callback_data: 'renter_api_menu' }]] }
    });
  }
  const prefix = mode === 'delete' ? 'renter_api_delete:' : (mode === 'disable' ? 'renter_api_disable:' : 'renter_api_use:');
  const kb = apis.map(a => ([{ text: `${a.provider || 'DigitalOcean'} API#${a.id} • ${a.email || '-'} • ${Number(a.status) === 1 ? 'Aktif' : 'Nonaktif'}`, callback_data: `${prefix}${a.id}` }]));
  kb.push([{ text: '« Kembali', callback_data: 'renter_api_menu' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih API cloud:', { reply_markup: { inline_keyboard: kb } });
}

async function deleteApi(bot, chatId, messageId, apiId) {
  await renterManager.deleteApi(chatId, apiId);
  return showApiMenu(bot, chatId, messageId);
}

async function disableApi(bot, chatId, messageId, apiId) {
  await renterManager.disableApi(chatId, apiId);
  return showApiMenu(bot, chatId, messageId);
}

async function processAddApi(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const sess = sessionManager.getAdminSession(chatId) || {};
  const provider = sess.provider || 'digitalocean';
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
  const label =
    provider === 'aws' ? 'AWS'
    : provider === 'linode' ? 'Linode'
    : provider === 'upcloud' ? 'UpCloud'
    : 'DigitalOcean';
  const isOnce = sess.returnTo === 'open_api_rdp';
  await bot.sendMessage(chatId, `⏳ Mengecek API ${label}${isOnce ? ' (sekali pakai)' : ' renter'}...`);
  try {
    const res = await renterManager.addApi(chatId, msg.text, provider, isOnce ? 1 : 0);
    const returnTo = sess.returnTo;
    sessionManager.clearAdminSession(chatId);
    if (returnTo === 'open_api_rdp') {
      await bot.sendMessage(chatId,
        `✅ Token ${res.provider || label} diterima (Email/ID: ${res.email || '-'}).\n\n` +
        `🔒 *Sekali pakai:* token ini TIDAK disimpan — otomatis dihapus setelah VPS dibuat.\n` +
        `⚠️ Karena tidak disimpan, VPS/RDP ini tidak bisa di-rebuild/reset lewat bot nanti (kelola dari akun cloud kamu, atau masukkan token lagi).`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚀 Lanjut Pilih Server & Install RDP', callback_data: 'install_src_api' }], [{ text: '🏠 Menu Utama', callback_data: 'back_to_menu' }]] } }
      );
    } else {
      await bot.sendMessage(chatId, `✅ API ${res.provider || label} berhasil ${res.exists ? 'diaktifkan kembali' : 'ditambahkan'}.\nEmail/ID: ${res.email || '-'}\n\nKetik /start untuk kembali.`);
    }
  } catch (e) {
    let hint = e.message || '';
    if (e.message === 'INVALID_AWS_FORMAT') hint = 'Format AWS harus ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION';
    if (e.message === 'INVALID_UPCLOUD_TOKEN') hint = 'Token UpCloud harus diawali `ucat_` (buat di https://hub.upcloud.com/account/api-tokens)';
    await bot.sendMessage(chatId, `❌ Gagal menambahkan API ${label}. ${hint}`);
  }
}

async function showInfo(bot, chatId, messageId) {
  if (!await requireRenter(bot, chatId, messageId)) return;
  const renter = await renterManager.getRenter(chatId);
  const instances = await renterManager.listInstances(chatId);
  const backup = instances.length ? instances.map(x => {
    const server = x.type === 'rdp' && x.ip ? `${x.ip}:${x.rdp_port || 4443}` : (x.ip || '-');
    return `${x.type.toUpperCase()} • ${server} • ${x.size_slug || '-'} • ${x.region || '-'}`;
  }).join('\n') : 'Belum ada data VPS/RDP dari menu renter.';
  const admin = process.env.ADMIN_USERNAME || process.env.ADMIN_CONTACT || 'Admin';
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    `ℹ️ *INFO RENTER*\n\n` +
    `📅 Masa aktif: ${renterManager.formatDate(renter.expires_at)}\n\n` +
    `💾 *Backup data anda:*\n${backup}\n\n` +
    `♻️ *Restore data anda:* gunakan data backup di atas / hubungi admin jika butuh bantuan.\n` +
    `📞 Hubungi admin: ${admin}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💾 Backup Sekarang', callback_data: 'renter_backup_now' }, { text: '♻️ Restore Data', callback_data: 'renter_restore_prompt' }], [{ text: '« Kembali', callback_data: 'renter_menu' }]] } }
  );
}

async function startCreate(bot, chatId, messageId, type, sessionManager) {
  if (!await requireRenter(bot, chatId, messageId)) return;
  const apis = await renterManager.listApis(chatId, true);
  if (!apis.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Tambahkan API DigitalOcean/Linode/AWS aktif terlebih dahulu.', {
      reply_markup: { inline_keyboard: [[{ text: '🔑 API Cloud', callback_data: 'renter_api_menu' }], [{ text: '« Kembali', callback_data: 'renter_menu' }]] }
    });
  }
  if (apis.length === 1) return pickApi(bot, chatId, messageId, type, apis[0].id, sessionManager);
  const kb = apis.map(a => ([{ text: apiLabel(a), callback_data: `renter_${type}_api:${a.id}` }]));
  kb.push([{ text: '« Kembali', callback_data: 'renter_menu' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, `Pilih API untuk membuat ${type.toUpperCase()}:`, { reply_markup: { inline_keyboard: kb } });
}

async function pickApi(bot, chatId, messageId, type, apiId, sessionManager) {
  const token = await renterManager.getApiToken(chatId, apiId);
  if (!token) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ API tidak aktif / tidak ditemukan.', { reply_markup: { inline_keyboard: [[{ text: '🔑 API Cloud', callback_data: 'renter_api_menu' }]] } });
  sessionManager.setAdminSession(chatId, { action: 'renter_create', type, apiId, messageId });
  const regions = await getRegions(token);
  if (!regions.length) return safeMessageEditor.editMessage(bot, chatId, messageId, `❌ Tidak ada region ${providerName(token)} tersedia.`, { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'renter_menu' }]] } });

  const kb = regions.slice(0, 60).map(r => ([{
    text: `${r.slug} (${r.name})`,
    callback_data: `renter_${type}_regionpick:${apiId}:${cbPack(r.slug)}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'renter_menu' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, `🌍 Pilih region ${type.toUpperCase()} terlebih dahulu:`, { reply_markup: { inline_keyboard: kb } });
}

async function pickRegionFirst(bot, chatId, messageId, type, apiId, region, sessionManager, page = 0) {
  const LOG = `[renter.pickRegionFirst chat=${chatId} type=${type} region=${region} page=${page} apiId=${apiId}]`;
  console.log(`${LOG} enter`);
  try {
    const token = await renterManager.getApiToken(chatId, apiId);
    if (!token) {
      console.log(`${LOG} no token → early return`);
      return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ API tidak aktif / tidak ditemukan.', { reply_markup: { inline_keyboard: [[{ text: '🔑 API Cloud', callback_data: 'renter_api_menu' }]] } });
    }

    const session = sessionManager.getAdminSession(chatId) || {};
    session.action = 'renter_create';
    session.type = type;
    session.apiId = Number(apiId);
    session.region = region;
    session.messageId = messageId;
    sessionManager.setAdminSession(chatId, session);

    // Try cache first — dramatically speeds up pagination clicks & mengurangi
    // panggilan API cloud provider (Linode/AWS/DO) berulang.
    let sizes = getCachedSizes(chatId, region, apiId);
    if (sizes) {
      console.log(`${LOG} cache HIT (n=${sizes.length})`);
    } else {
      const t0 = Date.now();
      sizes = await getSizesForRegion(token, region);
      console.log(`${LOG} cache MISS, fetched in ${Date.now() - t0}ms (n=${sizes ? sizes.length : 0})`);
      if (sizes && sizes.length) setCachedSizes(chatId, region, apiId, sizes);
    }

    if (!sizes || !sizes.length) {
      return safeMessageEditor.editMessage(bot, chatId, messageId,
        `❌ Tidak ada size yang tersedia untuk region *${region}*.\n\nSilakan pilih region lain.`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Pilih Region Lain', callback_data: `renter_${type}_api:${apiId}` }], [{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]] } }
      );
    }

    const perPage = 12;
    const totalPages = Math.max(1, Math.ceil(sizes.length / perPage));
    const p = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
    console.log(`${LOG} rendering page ${p + 1}/${totalPages}`);
    const regionTok = cbPack(region);
    const kb = sizes.slice(p * perPage, (p + 1) * perPage).map(s => {
      // Display: pakai `label` (nama plan asli, mis. "CLOUDNATIVE-4xCPU-8GB")
      // kalau ada — supaya user tahu spec-nya. Callback pakai `slug` yang
      // biasanya lebih pendek (mis. "up-4c-8g" untuk UpCloud) — supaya
      // tidak overflow limit 64 byte callback_data Telegram.
      const displayName = s.label || s.slug;
      return [{
        text: `${displayName} • ${Math.round(Number(s.memory || 0) / 1024)}GB RAM / ${s.vcpus} CPU`,
        callback_data: `renter_${type}_sizepick:${apiId}:${regionTok}:${cbPack(s.slug)}`,
      }];
    });
    const nav = [];
    if (p > 0) nav.push({ text: '⬅️ Halaman sebelumnya', callback_data: `renter_${type}_sizepage:${apiId}:${regionTok}:${p - 1}` });
    if (p < totalPages - 1) nav.push({ text: '➡️ Halaman berikutnya', callback_data: `renter_${type}_sizepage:${apiId}:${regionTok}:${p + 1}` });
    if (nav.length) kb.push(nav);
    kb.push([{ text: '« Kembali ke Region', callback_data: `renter_${type}_api:${apiId}` }]);

    // Include halaman ke-N di dalam text pesan supaya:
    //  1. User tahu ini halaman berapa dari berapa
    //  2. Text pesan BERUBAH tiap halaman → shouldUpdate() di safeMessageEditor
    //     dijamin return true, sehingga edit selalu di-apply (defence in depth
    //     kalau ada bug di JSON compare markup)
    const bodyText =
      `📦 Pilih spesifikasi ${type.toUpperCase()} yang tersedia di region *${region}*:\n\n` +
      `_Halaman ${p + 1}/${totalPages} · Klik SALAH SATU spesifikasi di atas untuk lanjut._`;
    const result = await safeMessageEditor.editMessage(bot, chatId, messageId, bodyText, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: kb },
    });
    console.log(`${LOG} editMessage → success=${result && result.success} skipped=${result && result.skipped}`);
    return result;
  } catch (err) {
    console.error(`${LOG} ERROR:`, err && err.stack || err);
    try {
      await safeMessageEditor.editMessage(bot, chatId, messageId,
        `❌ Gagal memuat daftar spesifikasi.\n\n\`${String(err && err.message || err).slice(0, 250)}\`\n\nSilakan coba lagi. Kalau masih gagal, cek koneksi & status API kamu di menu *🔑 API Cloud*.`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔄 Coba lagi', callback_data: `renter_${type}_regionpick:${apiId}:${cbPack(region)}` }], [{ text: '🔑 Menu API', callback_data: 'renter_api_menu' }]] } }
      );
    } catch (_) { /* ignore secondary error */ }
  }
}

async function pickSize(bot, chatId, messageId, type, apiId, region, sizeSlug, sessionManager) {
  const token = await renterManager.getApiToken(chatId, apiId);
  if (!token) return bot.sendMessage(chatId, '❌ API tidak aktif / tidak ditemukan.');
  const availableSizes = await getSizesForRegion(token, region);
  const exists = availableSizes.some(s => s.slug === sizeSlug);
  if (!exists) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      `❌ Size *${sizeSlug}* tidak tersedia di region *${region}*.\n\nSilakan pilih spesifikasi lain.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Pilih Spesifikasi', callback_data: `renter_${type}_regionpick:${apiId}:${cbPack(region)}` }], [{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]] } }
    );
  }
  const session = sessionManager.getAdminSession(chatId) || {};
  session.action = 'renter_create';
  session.type = type;
  session.apiId = Number(apiId);
  session.region = region;
  session.sizeSlug = sizeSlug;
  session.messageId = messageId;
  sessionManager.setAdminSession(chatId, session);

  if (type === 'vps') {
    const images = await getImages(token);
    const regionTok = cbPack(region);
    const sizeTok = cbPack(sizeSlug);
    const kb = images.map(i => ([{ text: i.label, callback_data: `renter_vps_image:${apiId}:${regionTok}:${sizeTok}:${cbPack(i.slug)}` }]));
    kb.push([{ text: '« Kembali ke Spesifikasi', callback_data: `renter_vps_regionpick:${apiId}:${regionTok}` }]);
    return safeMessageEditor.editMessage(bot, chatId, messageId, '💿 Pilih OS VPS:', { reply_markup: { inline_keyboard: kb } });
  }

  const wins = getWindowsList();
  const regionTok = cbPack(region);
  const sizeTok = cbPack(sizeSlug);
  const kb = wins.map((w, idx) => ([{ text: w.name, callback_data: `renter_rdp_win:${apiId}:${regionTok}:${sizeTok}:${idx}` }]));
  kb.push([{ text: '« Kembali ke Spesifikasi', callback_data: `renter_rdp_regionpick:${apiId}:${regionTok}` }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, '🪟 Pilih versi Windows:', { reply_markup: { inline_keyboard: kb } });
}

async function pickRegion(bot, chatId, messageId, type, apiId, sizeSlug, region, sessionManager) {
  return pickSize(bot, chatId, messageId, type, apiId, region, sizeSlug, sessionManager);
}

async function createVps(bot, chatId, messageId, apiId, sizeSlug, region, image) {
  const token = await renterManager.getApiToken(chatId, apiId);
  if (!token) return bot.sendMessage(chatId, '❌ API tidak aktif / tidak ditemukan.');
  const password = genAlphaNum(12);
  const cloudInit = rootCloudInit(password);
  await safeMessageEditor.editMessage(bot, chatId, messageId, `⏳ VPS renter sedang dibuat menggunakan API ${providerName(token)} kamu...`, { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]] } });
  const createRes = await createDroplet(token, `renter-vps-${chatId}-${genAlphaNum(6).toLowerCase()}`, region, sizeSlug, image, cloudInit);
  const { dropletId, error, sshPrivateKey } = createRes;
  if (!dropletId) return bot.sendMessage(chatId, `❌ Gagal membuat VPS\nReason: ${error}`);
  const ip = await waitPublicIp(token, dropletId, 20, 10000, region);
  if (!ip) {
    await deleteDroplet(token, dropletId, region);
    return bot.sendMessage(chatId, '⚠️ VPS dibuat tapi IP belum tersedia. Droplet sudah dicoba dihapus. Silakan coba lagi.');
  }
  await renterManager.saveInstance({ userId: chatId, type: 'vps', dropletId, ip, sizeSlug, region, image, rootPassword: password, apiId });

  // UpCloud: connect via SSH KEY (pola AWS) lalu AKTIF set root password +
  // enable password auth. Template UpCloud = key-only, jadi password harus
  // di-enable setelah masuk pakai key (bukan nunggu cloud-init yang racy).
  if (isUpCloudToken(token) && sshPrivateKey) {
    await safeMessageEditor.editMessage(bot, chatId, messageId,
      `⏳ VPS UpCloud dibuat, IP: ${ip}\n\nMengaktifkan akses root+password (2-4 menit)...`,
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]] } }
    ).catch(() => {});
    const { upcloudProvisionRootPassword } = require('../utils/upcloudApi');
    const ok = await upcloudProvisionRootPassword(ip, sshPrivateKey, password, {
      maxWaitMs: 6 * 60 * 1000,
      onLog: (m) => console.log(`[RENTER-VPS ${ip}] ${m}`),
    });
    if (!ok) console.log(`[RENTER-VPS ${ip}] provision root password TIMEOUT`);
  }

  return sendRenterVpsReady(bot, chatId, { ip, password, image, region, sizeSlug, provider: providerName(token) });
}

async function createRdp(bot, chatId, messageId, apiId, sizeSlug, region, winIndex) {
  const token = await renterManager.getApiToken(chatId, apiId);
  if (!token) return bot.sendMessage(chatId, '❌ API tidak aktif / tidak ditemukan.');
  const osList = getWindowsList();
  const selectedOS = osList[Number(winIndex)];
  if (!selectedOS) return bot.sendMessage(chatId, '❌ OS Windows tidak valid.');
  const rootPass = genAlphaNum(12);
  const rdpPass = genWindowsPassword();
  const hostname = `renter-rdp-${chatId}-${genAlphaNum(6).toLowerCase()}`;
    const cloudInit = rootCloudInit(rootPass);
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `⏳ VPS untuk RDP renter sedang dibuat menggunakan API ${providerName(token)} kamu...\n\n📦 Size: ${sizeSlug}\n🌍 Region: ${region}\n💿 Windows: ${selectedOS.name}`,
    { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]] } }
  );
  const baseImage = isAwsToken(token) ? 'aws:ubuntu22.04' : (isLinodeToken(token) ? 'linode/ubuntu22.04' : (isUpCloudToken(token) ? 'upcloud/ubuntu22.04' : 'ubuntu-22-04-x64'));
  const createSizeSlug = isAwsToken(token) ? normalizeAwsRdpSize(sizeSlug) : sizeSlug;
  const createRes = await createDroplet(token, hostname, region, createSizeSlug, baseImage, cloudInit);
  const { dropletId, error, sshPrivateKey, sshUsername } = createRes;
  if (!dropletId) return bot.sendMessage(chatId, '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.');
  const ip = await waitPublicIp(token, dropletId, 20, 10000, region);
  if (!ip) {
    await deleteDroplet(token, dropletId, region);
    return bot.sendMessage(chatId, '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.');
  }
  // Port RDP per-provider: UpCloud=3389 (lolos firewall default), lainnya=4443.
  const rdpPort = rdpPortForToken(token);
  // Token sekali-pakai: hapus dari DB sekarang (token sudah ada di variabel lokal
  // `token` untuk seluruh proses install). Instance disimpan dengan api_id null.
  let saveApiId = apiId;
  try { if (await renterManager.consumeOnceApi(chatId, apiId)) saveApiId = null; } catch (_) {}
  await renterManager.saveInstance({ userId: chatId, type: 'rdp', dropletId, ip, sizeSlug: createSizeSlug, region, image: `rdp:${selectedOS.version}`, rootPassword: rootPass, rdpPassword: rdpPass, windowsVersion: selectedOS.version, apiId: saveApiId, rdpPort });
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `🚀 Memulai instalasi Windows RDP renter...\n\n🌐 IP: ${ip}\n💿 Windows: ${selectedOS.name}\n🔒 Port RDP: ${rdpPort}\n\n⏰ Estimasi 30-40 menit (Alpine download image + DD + Windows first boot). Kamu akan dapat notifikasi saat RDP siap.`,
    { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]] } }
  );

  // Catatan: notif firewall UpCloud DIHAPUS. Port RDP UpCloud = 3389 yang
  // sudah di-accept firewall default UpCloud, jadi tidak perlu buka apa-apa
  // dan tidak perlu warning yang menyesatkan.

  (async () => {
    try {
      const sshReady = await waitForPort(ip, 22, 12 * 60 * 1000, 15000);
      if (!sshReady) {
        await bot.sendMessage(chatId, '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.');
        return;
      }
      const installProvider = isAwsToken(token) ? 'aws' : (isLinodeToken(token) ? 'linode' : (isUpCloudToken(token) ? 'upcloud' : 'digitalocean'));
      // UpCloud pakai SSH key auth (docs: satu-satunya method untuk cloud-init template).
      const upcloudKey = (isUpCloudToken(token) && sshPrivateKey) ? sshPrivateKey : null;
      const sshUser = upcloudKey ? (sshUsername || 'root') : 'root';
      const installCfg = { osVersion: selectedOS.version, password: rdpPass, provider: installProvider, rdpPort };
      if (upcloudKey) { installCfg.privateKey = upcloudKey; installCfg.useSudo = sshUser !== 'root'; }
      const installPromise = installDedicatedRDP(ip, sshUser, upcloudKey ? null : rootPass, installCfg, (logMessage) => console.log(`[RENTER ${ip}] ${logMessage}`));
      scheduleLinodeDirectDiskIfNeeded(token, dropletId, ip);
      await installPromise;
      const monitor = new RDPMonitor(ip, 'root', rootPass, rdpPass, rdpPort);
      const rdpResult = await monitor.waitForRDPReady(rdpPasswordUtil.RDP_MONITOR_TIMEOUT_MS, (statusMessage) => console.log(`[RENTER ${ip}] ${statusMessage}`));
      try { monitor.disconnect(); } catch (_) {}
      if (!rdpResult || !(rdpResult.success && rdpResult.rdpReady)) {
        await sendRenterRdpReadyMessages(bot, chatId, messageId, {
          ip, hostname, rdpPass, windowsName: selectedOS.name, region, sizeSlug: createSizeSlug,
          responseTime: 'N/A', totalTime: rdpResult?.totalTime || '15', ready: false, port: rdpPort
        });
        return;
      }
      await sendRenterRdpReadyMessages(bot, chatId, messageId, {
        ip,
        hostname,
        rdpPass,
        windowsName: selectedOS.name,
        region,
        sizeSlug: createSizeSlug,
        responseTime: rdpResult.responseTime || 'N/A',
        totalTime: rdpResult.totalTime || 'N/A',
        ready: !!(rdpResult.success && rdpResult.rdpReady),
        port: rdpPort
      });
    } catch (e) {
      console.error('Renter RDP install error:', e);
      await bot.sendMessage(chatId, '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.');
    }
  })();
}

async function backupNow(bot, chatId, messageId) {
  if (!await requireRenter(bot, chatId, messageId)) return;
  const backup = await renterManager.exportBackup(chatId);
  const dir = path.join(os.tmpdir(), 'renter-backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'renter-backup-' + chatId + '-' + Date.now() + '.json');
  fs.writeFileSync(file, JSON.stringify(backup, null, 2));
  await bot.sendDocument(chatId, file, { caption: '💾 Backup data renter kamu. Simpan file ini baik-baik.' });
  try { fs.unlinkSync(file); } catch (_) {}
  return showInfo(bot, chatId, messageId);
}

async function promptRestore(bot, chatId, messageId, sessionManager) {
  if (!await requireRenter(bot, chatId, messageId)) return;
  sessionManager.setAdminSession(chatId, { action: 'renter_restore_wait', messageId });
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '♻️ *Restore Data Renter*\n\nKirim file backup `.json` yang sebelumnya dibuat dari menu Backup Sekarang.\n\nData yang direstore: masa sewa, API cloud, dan data VPS/RDP renter.',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'renter_cancel_restore' }]] } }
  );
}

async function cancelRestore(bot, chatId, messageId, sessionManager) {
  sessionManager.clearAdminSession(chatId);
  return showInfo(bot, chatId, messageId);
}

async function processRestoreDocument(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const sess = sessionManager.getAdminSession(chatId);
  if (!sess || sess.action !== 'renter_restore_wait') return false;
  try {
    const dir = path.join(os.tmpdir(), 'renter-restore');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = await bot.downloadFile(msg.document.file_id, dir);
    const raw = fs.readFileSync(filePath, 'utf8');
    const backup = JSON.parse(raw);
    await renterManager.importBackup(chatId, backup);
    sessionManager.clearAdminSession(chatId);
    await bot.sendMessage(chatId, '✅ Restore data renter berhasil. Ketik /start untuk melihat menu.');
  } catch (e) {
    console.error('Renter restore error:', e);
    sessionManager.clearAdminSession(chatId);
    await bot.sendMessage(chatId, '❌ Restore gagal. Pastikan file backup renter berbentuk JSON dari menu Backup Sekarang.');
  }
  return true;
}

function sshExec(ip, username, password, cmd, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    const onError = (err) => { try { conn.end(); } catch (_) {} reject(err); };
    conn.on('ready', () => {
      conn.exec(cmd, { pty: true }, (err, stream) => {
        if (err) return onError(err);
        stream.on('close', (code) => {
          try { conn.end(); } catch (_) {}
          if (code === 0 || code === undefined || code === null) return resolve({ stdout, stderr, code });
          reject(new Error(stderr || stdout || 'Command failed: ' + code));
        });
        stream.on('data', d => { stdout += d.toString(); });
        stream.stderr.on('data', d => { stderr += d.toString(); });
      });
    }).on('error', onError);
    conn.connect({ host: ip, port: 22, username, password, readyTimeout: timeoutMs });
    setTimeout(() => { try { conn.end(); } catch (_) {} }, timeoutMs + 2000);
  });
}

async function showServices(bot, chatId, messageId) {
  if (!await requireRenter(bot, chatId, messageId)) return;
  const rows = await renterManager.listInstances(chatId);
  if (!rows.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '🗂️ *VPS&RDP Saya*\n\nBelum ada VPS/RDP dari menu renter.', {
      parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'renter_menu' }]] }
    });
  }
  const kb = rows.map(x => ([{ text: x.type.toUpperCase() + ' • ' + (x.ip || '-') + ' • ' + (x.size_slug || '-'), callback_data: 'renter_srv_view:' + x.id }]));
  kb.push([{ text: '« Kembali', callback_data: 'renter_menu' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, '🗂️ *VPS&RDP Saya*\n\nPilih server yang ingin dikelola:', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

async function viewService(bot, chatId, messageId, instanceId) {
  if (!await requireRenter(bot, chatId, messageId)) return;
  const x = await renterManager.getInstance(chatId, instanceId);
  if (!x) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Data tidak ditemukan.', { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'renter_services' }]] } });
  const type = x.type === 'rdp' ? 'RDP' : 'VPS';
  const server = x.type === 'rdp' && x.ip ? x.ip + ':' + (x.rdp_port || 4443) : (x.ip || '-');
  let text = '📄 *Detail ' + type + ' Renter*\n\n' +
    '🆔 ID: *' + x.id + '*\n' +
    '🌐 Server: *' + server + '*\n' +
    '📦 Size: *' + (x.size_slug || '-') + '*\n' +
    '🌍 Region: *' + (x.region || '-') + '*';
  if (x.type === 'vps') text += '\n🐧 OS: *' + (x.image || '-') + '*';
  else text += '\n🪟 Windows: *' + (x.windows_version || String(x.image || '').replace('rdp:', '') || '-') + '*\n👤 Username: *administrator*\n🔑 Password: _(hidden — klik tombol di bawah)_';
  text += '\n\nPilih aksi:';
  const kb = [];
  if (x.type === 'vps') {
    kb.push([{ text: '🔑 Reset Password', callback_data: 'renter_srv_confirm:reset_vps:' + x.id }]);
    kb.push([{ text: '🔄 Rebuild VPS', callback_data: 'renter_srv_confirm:rebuild_vps:' + x.id }]);
  } else {
    // Password is hidden by default. Renter must opt-in to reveal it,
    // same UX as the main bot flow (vpsOrderHandler.viewMyService).
    kb.push([{ text: '🔑 Lihat Password', callback_data: 'renter_view_rdp_pass:' + x.id }]);
    kb.push([{ text: '🔄 Rebuild RDP', callback_data: 'renter_srv_pickwin:rebuild_rdp:' + x.id }]);
  }
  kb.push([{ text: '📦 Backup Data', callback_data: 'backup_menu:-' + x.id }]);
  if (x.type === 'rdp') {
    kb.push([{ text: '🔄 Restore Data RDP', callback_data: 'backup_restore_ask:-' + x.id }]);
  } else {
    kb.push([{ text: '🔄 Restore Data VPS', callback_data: 'backup_restore_ask:-' + x.id }]);
  }
  kb.push([{ text: '🗑️ Hapus', callback_data: 'renter_srv_confirm:delete:' + x.id }]);
  kb.push([{ text: '« Kembali', callback_data: 'renter_services' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

/**
 * Reveal the stored RDP password for a renter's instance. Mirrors
 * vpsOrderHandler.showRdpPassword for the main-bot flow. Reads
 * rdp_password from renter_instances (populated by saveInstance at
 * initial install time and by updateInstancePassword on rebuild).
 *
 * Callback: `renter_view_rdp_pass:<instanceId>`
 * Hide-toggle navigates back to `renter_srv_view:<instanceId>` which
 * re-renders the detail card with the password hidden.
 */
async function showRenterRdpPassword(bot, chatId, messageId, instanceId) {
  if (!await requireRenter(bot, chatId, messageId)) return;
  const x = await renterManager.getInstance(chatId, instanceId);
  if (!x) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Data tidak ditemukan.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'renter_services' }]] }
    });
  }
  if (x.type !== 'rdp') {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Ini bukan RDP.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'renter_srv_view:' + x.id }]] }
    });
  }
  const pass = x.rdp_password || null;
  if (!pass) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '⚠️ Password RDP tidak tersimpan di database.\n\n' +
      'Kemungkinan RDP ini dibuat dengan versi bot lama, atau install belum selesai. ' +
      'Rebuild RDP untuk generate password baru yang akan tersimpan otomatis.',
      { reply_markup: { inline_keyboard: [
        [{ text: '🔄 Rebuild RDP', callback_data: 'renter_srv_pickwin:rebuild_rdp:' + x.id }],
        [{ text: '« Kembali', callback_data: 'renter_srv_view:' + x.id }]
      ] } }
    );
  }
  const ipText = x.ip ? (x.ip + ':' + (x.rdp_port || 4443)) : '-';
  const bt = '`';
  const text =
    '🔑 *Password RDP Renter*\n\n' +
    '🌐 Server: ' + bt + ipText + bt + '\n' +
    '👤 Username: ' + bt + 'administrator' + bt + '\n' +
    '🔑 Password: ' + bt + pass + bt + '\n\n' +
    '_Tekan tombol Copy untuk salin, atau Sembunyikan untuk kembali._';
  return safeMessageEditor.editMessage(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Copy Password', callback_data: 'copy_pass_' + pass }],
        [{ text: '📋 Copy Server', callback_data: 'copy_server_' + (x.ip || '') + ':' + (x.rdp_port || 4443) }],
        [{ text: '🙈 Sembunyikan', callback_data: 'renter_srv_view:' + x.id }]
      ]
    }
  });
}

async function confirmService(bot, chatId, messageId, action, instanceId) {
  const x = await renterManager.getInstance(chatId, instanceId);
  if (!x) return bot.sendMessage(chatId, '❌ Data tidak ditemukan.');
  let warn = '⚠️ Apakah kamu yakin?';
  if (action === 'delete') warn = '⚠️ *Konfirmasi Hapus*\n\nServer akan dihapus permanen dari provider cloud dan data lokal akan dinonaktifkan.';
  if (action === 'reset_vps') warn = '⚠️ *Konfirmasi Reset Password VPS*\n\nPassword root akan diganti dan dikirim ke kamu.';
  if (action === 'rebuild_vps') warn = '⚠️ *Konfirmasi Rebuild VPS*\n\nVPS akan dibuat ulang. *Semua data di server lama akan hilang.*';
  return safeMessageEditor.editMessage(bot, chatId, messageId, warn, {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '✅ Ya', callback_data: 'renter_srv_exec:' + action + ':' + instanceId }],
      [{ text: '❌ Batal', callback_data: 'renter_srv_view:' + instanceId }]
    ] }
  });
}

async function pickWindowsForService(bot, chatId, messageId, action, instanceId) {
  const wins = getWindowsList();
  const kb = wins.map((w, idx) => ([{ text: w.name, callback_data: 'renter_srv_execwin:' + action + ':' + instanceId + ':' + idx }]));
  kb.push([{ text: '« Kembali', callback_data: 'renter_srv_view:' + instanceId }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, '🪟 Pilih versi Windows untuk rebuild RDP:', { reply_markup: { inline_keyboard: kb } });
}

async function executeService(bot, chatId, messageId, action, instanceId, winIndex = null) {
  const x = await renterManager.getInstance(chatId, instanceId);
  if (!x) return bot.sendMessage(chatId, '❌ Data tidak ditemukan.');
  const token = x.api_id ? await renterManager.getApiToken(chatId, x.api_id) : await renterManager.getDefaultApiToken(chatId);
  if (!token) return bot.sendMessage(chatId, '❌ API cloud aktif tidak ditemukan. Aktifkan/tambahkan API dulu.');

  if (action === 'delete') {
    await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ Menghapus server renter...', { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]] } });
    if (x.droplet_id) await deleteDroplet(token, x.droplet_id, x.region || null);
    await renterManager.markInstanceDeleted(chatId, instanceId);
    return bot.sendMessage(chatId, '✅ Server berhasil dihapus.');
  }

  if (action === 'reset_vps') {
    const newPass = genAlphaNum(14);
    try {
      await sshExec(x.ip, 'root', x.root_password, 'echo "root:' + newPass + '" | chpasswd');
      await renterManager.updateInstancePassword(chatId, instanceId, newPass, 'root');
      return bot.sendMessage(chatId, '✅ *Password VPS berhasil direset!*\n\n🌐 IP: `' + x.ip + '`\n👤 Username: `root`\n🔑 Password Baru: `' + newPass + '`', { parse_mode: 'Markdown' });
    } catch (e) {
      return bot.sendMessage(chatId, '❌ Gagal reset password via SSH. Jika password lama sudah berubah, gunakan Rebuild VPS untuk password baru.');
    }
  }

  const recreate = async (image, type, winVersion = null) => {
    const rootPass = genAlphaNum(12);
    const cloudInit = rootCloudInit(rootPass);
    await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ Membuat server baru dan menghapus server lama...', { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]] } });
    const defaultRegion = isAwsToken(token) ? 'us-east-1' : (isLinodeToken(token) ? 'sg-sin-2' : 'sgp1');
    const defaultSize = isAwsToken(token) ? 't3.medium' : (isLinodeToken(token) ? 'g6-standard-1' : 's-1vcpu-1gb');
    const recreateSizeSlug = (type === 'rdp' && isAwsToken(token)) ? normalizeAwsRdpSize(x.size_slug || defaultSize) : (x.size_slug || defaultSize);
    const result = await createDroplet(token, 'renter-' + type + '-' + chatId + '-' + genAlphaNum(6).toLowerCase(), x.region || defaultRegion, recreateSizeSlug, image, cloudInit);
    if (!result.dropletId) throw new Error(result.error || 'Gagal membuat droplet baru.');
    const ip = await waitPublicIp(token, result.dropletId, 20, 10000, x.region || defaultRegion);
    if (!ip) throw new Error('IP droplet baru belum tersedia.');
    if (x.droplet_id) { try { await deleteDroplet(token, x.droplet_id, x.region || null); } catch (_) {} }
    await renterManager.updateInstanceDroplet(chatId, instanceId, { dropletId: result.dropletId, ip, region: x.region, image: winVersion ? 'rdp:' + winVersion : image, rootPassword: rootPass, windowsVersion: winVersion, apiId: x.api_id, rdpPort: rdpPortForToken(token) });
    // sshPrivateKey/sshUsername ikut kembali biar caller bisa pass ke installer
    // (UpCloud pakai SSH key auth, docs).
    return { ip, rootPass, dropletId: result.dropletId, sshPrivateKey: result.sshPrivateKey || null, sshUsername: result.sshUsername || null };
  };

  if (action === 'rebuild_vps') {
    try {
      const image = x.image && !String(x.image).startsWith('rdp:') ? x.image : (isAwsToken(token) ? 'aws:ubuntu22.04' : (isLinodeToken(token) ? 'linode/ubuntu22.04' : (isUpCloudToken(token) ? 'upcloud/ubuntu22.04' : 'ubuntu-22-04-x64')));
      const r = await recreate(image, 'vps');
      return sendRenterVpsReady(bot, chatId, { ip: r.ip, password: r.rootPass, image, region: x.region || '-', sizeSlug: x.size_slug || '-' });
    } catch (e) {
      return bot.sendMessage(chatId, '❌ Rebuild VPS gagal: ' + (e.message || e));
    }
  }

  if (action === 'rebuild_rdp') {
    try {
      const wins = getWindowsList();
      const selectedOS = wins[Number(winIndex)] || wins[0];
      const rdpPass = genWindowsPassword();
      const r = await recreate(isAwsToken(token) ? 'aws:ubuntu22.04' : (isLinodeToken(token) ? 'linode/ubuntu22.04' : (isUpCloudToken(token) ? 'upcloud/ubuntu22.04' : 'ubuntu-22-04-x64')), 'rdp', selectedOS.version);

      // ─── BUGFIX (SSH wait before install): parity with create-RDP ────
      // Previously we launched installDedicatedRDP + Linode direct-disk
      // schedule immediately after recreate(). The direct-disk 5/7/9 min
      // timer was anchored to the recreate() return — which is 2-5 min
      // BEFORE the VPS is actually reachable. On Linode this frequently
      // set direct-disk before Alpine finished pulling the Windows image,
      // leaving the machine stuck at `grub>` on reboot. Waiting for SSH
      // first anchors the schedule to "SSH ready", same as create-RDP.
      await bot.sendMessage(chatId, '⏳ Menunggu VPS boot dan port SSH siap...');
      const sshReady = await waitForPort(r.ip, 22, 12 * 60 * 1000, 15000);
      if (!sshReady) {
        return bot.sendMessage(chatId,
          '❌ VPS tidak menyala dalam 12 menit setelah rebuild.\n\n' +
          'Coba rebuild lagi. Kalau gagal berulang, cek status VPS di panel provider.'
        );
      }

      const rdpPort = rdpPortForToken(token);
      await bot.sendMessage(chatId, '🚀 Memulai rebuild RDP renter...\n\n🌐 IP: ' + r.ip + '\n💿 Windows: ' + selectedOS.name + '\n🔒 Port RDP: ' + rdpPort + '\n\nEstimasi 30-40 menit.');

      // BUGFIX (save password BEFORE install): previously saved AFTER
      // `await installPromise`. If installPromise rejected or the user
      // checked "Lihat Password" during the 10-15 min install window,
      // the DB still had the old rdp_password from a prior install and
      // the renter had no way to know the new credentials. Save now so
      // the DB is the source of truth from t=0.
      await renterManager.updateInstancePassword(chatId, instanceId, rdpPass, 'rdp');

      const installProvider = isAwsToken(token) ? 'aws' : (isLinodeToken(token) ? 'linode' : (isUpCloudToken(token) ? 'upcloud' : 'digitalocean'));
      // UpCloud rebuild: pakai fresh SSH key dari createDroplet (recreate).
      const rbUpcloudKey = (isUpCloudToken(token) && r.sshPrivateKey) ? r.sshPrivateKey : null;
      const rbSshUser = rbUpcloudKey ? (r.sshUsername || 'root') : 'root';
      const rbInstallCfg = { osVersion: selectedOS.version, password: rdpPass, provider: installProvider, rdpPort };
      if (rbUpcloudKey) { rbInstallCfg.privateKey = rbUpcloudKey; rbInstallCfg.useSudo = rbSshUser !== 'root'; }
      const installPromise = installDedicatedRDP(r.ip, rbSshUser, rbUpcloudKey ? null : r.rootPass, rbInstallCfg, (logMessage) => console.log('[RENTER REBUILD ' + r.ip + '] ' + logMessage));
      scheduleLinodeDirectDiskIfNeeded(token, r.dropletId, r.ip);
      await installPromise;
      const monitor = new RDPMonitor(r.ip, 'root', r.rootPass, rdpPass, rdpPort);
      const rdpResult = await monitor.waitForRDPReady(rdpPasswordUtil.RDP_MONITOR_TIMEOUT_MS, (statusMessage) => console.log('[RENTER REBUILD ' + r.ip + '] ' + statusMessage));
      try { monitor.disconnect(); } catch (_) {}
      if (!rdpResult || !(rdpResult.success && rdpResult.rdpReady)) {
        return sendRenterRdpReadyMessages(bot, chatId, null, {
          ip: r.ip, hostname: 'renter-rdp-' + chatId, rdpPass, windowsName: selectedOS.name,
          region: x.region || '-', sizeSlug: x.size_slug || '-', responseTime: 'N/A', totalTime: rdpResult?.totalTime || '15', ready: false, port: rdpPort
        });
      }
      return sendRenterRdpReadyMessages(bot, chatId, null, {
        ip: r.ip,
        hostname: 'renter-rdp-' + chatId,
        rdpPass,
        windowsName: selectedOS.name,
        region: x.region || '-',
        sizeSlug: x.size_slug || '-',
        responseTime: rdpResult.responseTime || 'N/A',
        totalTime: rdpResult.totalTime || 'N/A',
        ready: !!(rdpResult.success && rdpResult.rdpReady),
        port: rdpPort
      });
    } catch (e) {
      return bot.sendMessage(chatId, '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.');
    }
  }
}

async function showAdminMenu(bot, chatId, messageId) {
  return safeMessageEditor.editMessage(bot, chatId, messageId, '🔐 *ADMIN SEWA*\n\nKelola penyewa bot:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '➕ Tambah Penyewa', callback_data: 'admin_renter_add' }],
      [{ text: '🗑️ Hapus Penyewa', callback_data: 'admin_renter_remove' }],
      [{ text: '📋 List Penyewa', callback_data: 'admin_renter_list' }],
      [{ text: '💰 Ubah Harga Sewa', callback_data: 'admin_renter_price' }],
      [{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]
    ] }
  });
}

/**
 * Tier picker for the "Ubah Harga Sewa" admin flow. From here the admin
 * chooses whether to edit Basic or Premium prices.
 */
async function showAdminPriceTierMenu(bot, chatId, messageId) {
  const { basic, premium } = await renterManager.getAllTierPrices();
  const text =
    `💰 *Ubah Harga Sewa Bot*\n\n` +
    `🥈 *Basic saat ini*\n` +
    `  • Harian: ${formatRp(basic.daily)}\n` +
    `  • Mingguan: ${formatRp(basic.weekly)}\n` +
    `  • Bulanan: ${formatRp(basic.monthly)}\n\n` +
    `🥇 *Premium saat ini*\n` +
    `  • Harian: ${formatRp(premium.daily)}\n` +
    `  • Mingguan: ${formatRp(premium.weekly)}\n` +
    `  • Bulanan: ${formatRp(premium.monthly)}\n\n` +
    `Pilih tier yang ingin diubah harganya:`;
  return safeMessageEditor.editMessage(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🥈 Ubah Harga BASIC', callback_data: 'admin_renter_price_basic' }],
      [{ text: '🥇 Ubah Harga PREMIUM', callback_data: 'admin_renter_price_premium' }],
      [{ text: '« Kembali', callback_data: 'admin_renter_menu' }]
    ] }
  });
}

async function promptAdminSetPrice(bot, chatId, messageId, sessionManager, tier = 'basic') {
  const t = renterManager.normalizeTier(tier);
  const prices = await renterManager.getRentPrices(t);
  const tierLabel = t === 'premium' ? 'PREMIUM 🥇' : 'BASIC 🥈';
  sessionManager.setAdminSession(chatId, { action: 'admin_renter_price', tier: t, messageId });
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    `💰 *Ubah Harga Sewa ${tierLabel}*\n\n` +
    `Harga saat ini:\n` +
    `Harian: ${formatRp(prices.daily)}\n` +
    `Mingguan: ${formatRp(prices.weekly)}\n` +
    `Bulanan: ${formatRp(prices.monthly)}\n\n` +
    `Masukkan harga baru format:\n\`harian mingguan bulanan\`\n` +
    `Contoh: \`${t === 'premium' ? '20000 100000 300000' : '10000 50000 150000'}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'admin_renter_price' }]] } }
  );
}

async function processAdminSetPrice(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const sess = sessionManager.getAdminSession(chatId) || {};
  const tier = renterManager.normalizeTier(sess.tier);
  const parts = String(msg.text || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3 || parts.some(p => !/^\d+$/.test(p))) {
    await bot.sendMessage(chatId, '❌ Format salah. Contoh: `10000 50000 150000`', { parse_mode: 'Markdown' });
    return;
  }
  const prices = await renterManager.setRentPrices(tier, Number(parts[0]), Number(parts[1]), Number(parts[2]));
  sessionManager.clearAdminSession(chatId);
  const tierLabel = tier === 'premium' ? 'Premium 🥇' : 'Basic 🥈';
  await bot.sendMessage(chatId,
    `✅ Harga sewa ${tierLabel} berhasil diubah.\n` +
    `Harian: ${formatRp(prices.daily)}\n` +
    `Mingguan: ${formatRp(prices.weekly)}\n` +
    `Bulanan: ${formatRp(prices.monthly)}`
  );
}

async function promptAdminAdd(bot, chatId, messageId, sessionManager) {
  sessionManager.setAdminSession(chatId, { action: 'admin_renter_add', messageId });
  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Masukkan user id + hari.\nContoh: `7282727 30`', {
    parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'admin_renter_menu' }]] }
  });
}

async function promptAdminRemove(bot, chatId, messageId, sessionManager) {
  sessionManager.setAdminSession(chatId, { action: 'admin_renter_remove', messageId });
  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Masukkan user id penyewa yang ingin dihapus.', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'admin_renter_menu' }]] }
  });
}

async function adminList(bot, chatId, messageId) {
  const rows = await renterManager.listRenters();
  const text = rows.length
    ? rows.map(r => {
        const tierBadge = renterManager.normalizeTier(r.tier) === 'premium' ? '🥇 PREMIUM' : '🥈 BASIC';
        return `• ${tierBadge} | ${r.user_id} ${r.username ? '@' + r.username : ''}\n  Exp: ${renterManager.formatDate(r.expires_at)}`;
      }).join('\n')
    : 'Belum ada penyewa aktif.';

  // Jangan pakai Markdown di sini karena username Telegram bisa mengandung underscore
  // dan membuat error: can't parse entities.
  return safeMessageEditor.editMessage(bot, chatId, messageId, `📋 LIST PENYEWA\n\n${text}`, {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'admin_renter_menu' }]] }
  });
}

async function processAdminAdd(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const parts = String(msg.text || '').trim().split(/\s+/);
  if (parts.length < 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
    await bot.sendMessage(chatId, '❌ Format salah. Contoh: `7282727 30`', { parse_mode: 'Markdown' });
    return;
  }
  const res = await renterManager.addRenter(Number(parts[0]), Number(parts[1]));
  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId, `✅ Penyewa ditambahkan.\nUser ID: ${res.userId}\nAktif sampai: ${renterManager.formatDate(res.expiresAt)}`);
}

async function processAdminRemove(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const uid = String(msg.text || '').trim();
  if (!/^\d+$/.test(uid)) {
    await bot.sendMessage(chatId, '❌ User ID harus angka.');
    return;
  }
  await renterManager.removeRenter(Number(uid));
  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId, `✅ Penyewa ${uid} berhasil dihapus.`);
}

// ============================================================
// "Install RDP pakai API cloud sendiri" — entry TERBUKA (tanpa gate renter).
// Dipakai menu Install RDP (4c). Mid-chain (pickApi/pickRegionFirst/pickSize/createRdp)
// tidak ter-gate, jadi callback renter_rdp_api/regionpick/sizepick/win yang ada bisa dipakai.
// ============================================================
async function startOpenApiRdp(bot, chatId, messageId, sessionManager) {
  const apis = await renterManager.listApis(chatId, true);
  if (!apis.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '🔑 *Install RDP via API Cloud Sendiri*\n\nKamu belum punya API cloud tersimpan. Tambahkan token API provider kamu ' +
      '(VPS dibuat & RDP diinstall otomatis di akun cloud milikmu):',
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '➕ API DigitalOcean', callback_data: 'open_api_add:digitalocean' }],
        [{ text: '➕ API Linode', callback_data: 'open_api_add:linode' }],
        [{ text: '➕ API AWS', callback_data: 'open_api_add:aws' }],
        [{ text: '➕ API UpCloud', callback_data: 'open_api_add:upcloud' }],
        [{ text: '« Kembali', callback_data: 'install_dedicated_rdp' }]
      ] } }
    );
  }
  const kb = apis.map(a => ([{ text: apiLabel(a), callback_data: `renter_rdp_api:${a.id}` }]));
  kb.push([{ text: '➕ DigitalOcean', callback_data: 'open_api_add:digitalocean' }, { text: '➕ Linode', callback_data: 'open_api_add:linode' }]);
  kb.push([{ text: '➕ AWS', callback_data: 'open_api_add:aws' }, { text: '➕ UpCloud', callback_data: 'open_api_add:upcloud' }]);
  kb.push([{ text: '« Kembali', callback_data: 'install_dedicated_rdp' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🔑 *Install RDP via API Cloud Sendiri*\n\nPilih API cloud untuk membuat VPS + install RDP:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

async function promptOpenApiAdd(bot, chatId, messageId, sessionManager, provider = 'digitalocean') {
  const p = String(provider || 'digitalocean').toLowerCase();
  const label = p === 'aws' ? 'AWS' : (p === 'linode' ? 'Linode' : (p === 'upcloud' ? 'UpCloud' : 'DigitalOcean'));
  sessionManager.setAdminSession(chatId, { action: 'renter_add_api', provider: p, messageId, returnTo: 'open_api_rdp' });
  let extra = '';
  if (p === 'aws') extra = '\n\nFormat AWS:\n`ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION`';
  else if (p === 'upcloud') extra = '\n\nToken UpCloud diawali `ucat_` (buat di hub.upcloud.com/account/api-tokens, allowed IPs 0.0.0.0/0).';
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    `🔑 Masukkan token/API ${label} kamu:${extra}\n\nToken akan dihapus dari chat setelah dikirim.`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'install_src_api' }]] }
  });
}

module.exports = {
  showRentOffer,
  startRentPurchase,
  startOpenApiRdp,
  promptOpenApiAdd,
  refreshRentPayment,
  cancelRentPayment,
  showStartChoice,
  showRenterMenu,
  showApiMenu,
  promptAddApi,
  showApiPick,
  deleteApi,
  disableApi,
  processAddApi,
  showInfo,
  backupNow,
  promptRestore,
  cancelRestore,
  processRestoreDocument,
  showServices,
  viewService,
  showRenterRdpPassword,
  confirmService,
  pickWindowsForService,
  executeService,
  startCreate,
  pickApi,
  pickRegionFirst,
  pickSize,
  pickRegion,
  createVps,
  createRdp,
  showAdminMenu,
  promptAdminAdd,
  promptAdminRemove,
  adminList,
  showAdminPriceTierMenu,
  promptAdminSetPrice,
  processAdminSetPrice,
  processAdminAdd,
  processAdminRemove,
  // Renter tier system
  showUpgradeOffer,
  requirePremiumRenter
};
