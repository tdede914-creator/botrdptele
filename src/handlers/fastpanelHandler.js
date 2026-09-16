const crypto = require('crypto');
const { isAdmin, getBalance, deductBalance, addBalance } = require('../utils/userManager');
const safeMessageEditor = require('../utils/safeMessageEdit');
const fastpanelManager = require('../utils/fastpanelManager');
const adminSettings = require('../utils/adminSettings');
const {
  getSizes, getRegions, createDroplet, waitPublicIp, deleteDroplet,
  isAwsToken, isLinodeToken, parseAwsToken
} = require('../utils/doApi');
const vpsManager = require('../utils/vpsManager');
const { installFastpanel } = require('../utils/fastpanelInstaller');
const { notifyFastpanelOrderSuccess, notifyFastpanelExpired, notifyOrderTestimonial } = require('../utils/orderNotifier');

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function genPass(n = 18) {
  const raw = crypto.randomBytes(48).toString('base64').replace(/[/+=]/g, '');
  return `${raw.slice(0, Math.max(12, Number(n) || 18))}-FASTPANEL-143`;
}

/**
 * Send a failure report to the user. If the log is short, sent as a single
 * message. If long (>3500 chars), sent as an attached .log file so the full
 * diagnostic dump (dpkg errors, apt errors, fastpanel install log tail, etc.)
 * survives Telegram's 4096-char message limit.
 */
async function sendFailureReport(bot, chatId, prefix, err) {
  const raw = String(err?.message || err || 'unknown error');
  // Short path: fits comfortably in one Telegram message.
  if (raw.length <= 3500) {
    return bot.sendMessage(chatId, `${prefix}Reason:\n${raw}`);
  }
  // Long path: send summary + attach full log as a file.
  const summary = raw.split('\n').slice(0, 15).join('\n');
  try {
    await bot.sendMessage(chatId,
      `${prefix}Reason (log lengkap dilampirkan sebagai file):\n\n${summary}\n...\n(lihat file berisi tail log lengkap)`
    );
    return await bot.sendDocument(chatId, Buffer.from(raw, 'utf8'), {}, {
      filename: `fastpanel-install-fail-${Date.now()}.log`,
      contentType: 'text/plain'
    });
  } catch (_) {
    // Fallback if sendDocument fails (e.g. permission)
    return bot.sendMessage(chatId, `${prefix}Reason:\n${raw.slice(0, 3500)}`);
  }
}

function genFastpanelPass() {
  // Fastpanel password should be reasonably strong. Avoid characters that could
  // break shell quoting inside the installer. Length ~14-16 is fine.
  const raw = crypto.randomBytes(24).toString('base64').replace(/[/+=]/g, '');
  return `Fp${raw.slice(0, 14)}!9`;
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

async function getInstallPrice() {
  return await adminSettings.getNumber('fastpanel_install_price', 15000);
}

function priceByDuration(prod, durationDays) {
  return Number(durationDays) === 7
    ? Number(prod.price_weekly || prod.price || 170000)
    : Number(prod.price || prod.price_monthly || 170000);
}

function slotByDuration(prod, durationDays) {
  return Number(durationDays) === 7
    ? Number(prod.slot_weekly || 0)
    : Number(prod.slot_monthly || prod.slot || 0);
}

/**
 * Pick an appropriate Ubuntu image slug for the given API provider.
 * Fastpanel needs Debian/Ubuntu; we standardize on Ubuntu 22.04.
 */
function ubuntuImageForToken(token) {
  if (isAwsToken(token)) return 'aws:ubuntu22.04';
  if (isLinodeToken(token)) return 'linode/ubuntu22.04';
  return 'ubuntu-22-04-x64';
}

/**
 * Pick a region for the given API provider.
 * - AWS: taken from the token itself (already region-scoped)
 * - DO/Linode: env override (FASTPANEL_DO_REGION / FASTPANEL_LINODE_REGION) first,
 *   otherwise pick the first available region reported by the provider API.
 */
async function pickRegionForToken(token) {
  if (isAwsToken(token)) {
    try {
      const parsed = parseAwsToken(token);
      return parsed.region || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    } catch (_) {
      return process.env.AWS_DEFAULT_REGION || 'us-east-1';
    }
  }
  if (isLinodeToken(token)) {
    const envReg = (process.env.FASTPANEL_LINODE_REGION || '').trim();
    if (envReg) return envReg;
    try {
      const regions = await getRegions(token);
      const preferred = regions.find(r => /ap-south|singapore|jp-|us-east|us-west|eu-|de-|nl-/i.test(String(r.slug || '')));
      return (preferred || regions[0])?.slug || 'us-east';
    } catch (_) {
      return 'us-east';
    }
  }
  const envReg = (process.env.FASTPANEL_DO_REGION || '').trim();
  if (envReg) return envReg;
  try {
    const regions = await getRegions(token);
    const preferred = regions.find(r => /^(sgp1|sfo3|nyc3|nyc1|ams3|fra1|lon1|blr1|syd1)$/i.test(String(r.slug || '')));
    return (preferred || regions[0])?.slug || 'sgp1';
  } catch (_) {
    return 'sgp1';
  }
}

/* -------------------------------------------------------------------------- */
/*  User: Menu / Manual install                                               */
/* -------------------------------------------------------------------------- */

async function showFastpanelMenu(bot, chatId, messageId) {
  const installPrice = await getInstallPrice();
  const kb = [
    [{ text: `🛠️ Jasa Install Fastpanel - Rp ${installPrice.toLocaleString('id-ID')}`, callback_data: 'fastpanel_install' }],
    [{ text: '⚡ Order Fastpanel', callback_data: 'fastpanel_order' }],
    [{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]
  ];
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '⚡ *MENU FASTPANEL*\n\nFastpanel adalah web hosting control panel gratis.\nBerjalan di port *8888* (HTTPS).\n\nPilih layanan:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
  );
}

async function startManualInstall(bot, chatId, messageId, sessionManager) {
  const price = await getInstallPrice();
  if (!isAdmin(chatId)) {
    const bal = await getBalance(chatId);
    if (Number(bal || 0) < price) {
      return safeMessageEditor.editMessage(bot, chatId, messageId,
        `❌ Saldo tidak cukup.\nButuh: Rp ${price.toLocaleString('id-ID')}`,
        { reply_markup: { inline_keyboard: [[{ text: '💳 Deposit', callback_data: 'deposit' }], [{ text: '« Kembali', callback_data: 'fastpanel_menu' }]] } }
      );
    }
  }

  const msg = await safeMessageEditor.editMessage(bot, chatId, messageId,
    `🛠️ *Jasa Install Fastpanel*\n\n` +
    `Harga: Rp ${price.toLocaleString('id-ID')}\n` +
    `Port panel: 8888 (HTTPS)\n\n` +
    `📌 Syarat VPS:\n` +
    `• OS: Ubuntu 20.04/22.04/24.04 atau Debian 10/11/12 (fresh install)\n` +
    `• Belum ada nginx/apache/mysql yang jalan\n` +
    `• RAM minimal 1GB (rekomendasi 2GB)\n\n` +
    `Kirim IP VPS:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'cancel_installation' }]] } }
  );

  sessionManager.setUserSession(chatId, {
    installType: 'fastpanel_manual',
    step: 'waiting_ip',
    messageId: msg?.message_id || messageId,
    price
  });
}

async function processManualInstall(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getUserSession(chatId);
  if (!session || session.installType !== 'fastpanel_manual') return false;

  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}

  if (session.step === 'waiting_ip') {
    const ip = String(msg.text || '').trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      await bot.sendMessage(chatId, '❌ IP tidak valid. Kirim IP VPS yang benar.');
      return true;
    }
    session.ip = ip;
    session.step = 'waiting_user';
    sessionManager.setUserSession(chatId, session);
    await bot.sendMessage(chatId, 'Kirim username SSH VPS, biasanya `root`:', { parse_mode: 'Markdown' });
    return true;
  }

  if (session.step === 'waiting_user') {
    session.username = String(msg.text || '').trim() || 'root';
    session.step = 'waiting_pass';
    sessionManager.setUserSession(chatId, session);
    await bot.sendMessage(chatId, 'Kirim password SSH VPS:');
    return true;
  }

  if (session.step === 'waiting_pass') {
    session.password = String(msg.text || '').trim();
    sessionManager.clearUserSession(chatId);

    if (!isAdmin(chatId)) {
      const ok = await deductBalance(chatId, Number(session.price));
      if (!ok) return bot.sendMessage(chatId, '❌ Saldo tidak cukup / berubah. Silakan deposit dulu.');
    }

    const status = await bot.sendMessage(chatId, '⏳ Instalasi Fastpanel dimulai. Estimasi 8-15 menit...');

    const fpPass = genFastpanelPass();
    try {
      const result = await installFastpanel(session.ip, session.username, session.password, {
        fastpanelUser: 'fastuser',
        fastpanelPassword: fpPass
      }, (line) => {
        const s = String(line || '');
        if (/SUCCESS|PORT=|FP_USER=|FP_PASS=|FP_URL=|Failed|Error|❌|✅/.test(s)) {
          console.log(`[FASTPANEL ${session.ip}] ${s}`);
        }
      });

      await bot.sendMessage(chatId,
        `✅ *INSTALL FASTPANEL SELESAI!*\n` +
        `🌐 URL: ${result.url}\n` +
        `👤 Username: \`${result.username}\`\n` +
        `🔑 Password: \`${result.password}\`\n` +
        `🔒 Port: ${result.port}\n` +
        `💰 Harga: Rp ${Number(session.price).toLocaleString('id-ID')}\n\n` +
        `⚠️ Panel pakai SSL self-signed, browser mungkin peringatan. Klik "Advanced → Proceed".`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      if (!isAdmin(chatId)) {
        try { await addBalance(chatId, Number(session.price)); } catch (_) {}
      }
      await sendFailureReport(bot, chatId,
        `❌ Install Fastpanel gagal.\nSaldo dikembalikan jika sempat terpotong.\n`,
        e
      );
    }
    try { await bot.deleteMessage(chatId, status.message_id); } catch (_) {}
    return true;
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/*  User: Auto-order (create VPS + install Fastpanel)                         */
/* -------------------------------------------------------------------------- */

async function showOrder(bot, chatId, messageId) {
  const products = await fastpanelManager.listActiveProducts();
  if (!products.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '❌ Stok Fastpanel kosong.\n\nHubungi admin untuk menambahkan spesifikasi Fastpanel.',
      { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'fastpanel_menu' }]] } }
    );
  }

  const kb = products.slice(0, 30).map(p => {
    const provider = fastpanelManager.providerLabel(fastpanelManager.apiProviderKey(p));
    const weekly = Number(p.slot_weekly || 0);
    const monthly = Number(p.slot_monthly || p.slot || 0);
    return ([{
      text: `${provider} • RAM ${p.ram}GB / ${p.core}C • 7H ${fastpanelManager.formatRp(p.price_weekly || p.price)} • 30H ${fastpanelManager.formatRp(p.price || 170000)} • Stok ${weekly}/${monthly}`,
      callback_data: `fastpanel_pick:${p.id}`
    }]);
  });
  kb.push([{ text: '« Kembali', callback_data: 'fastpanel_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '⚡ *ORDER FASTPANEL*\n\nPilih spesifikasi (sudah include Fastpanel siap pakai):',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
  );
}

async function pickDuration(bot, chatId, messageId, productId) {
  const prod = await fastpanelManager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk Fastpanel tidak ditemukan.');

  const kb = [];
  if (Number(prod.slot_weekly || 0) > 0) {
    kb.push([{ text: `7 Hari - ${fastpanelManager.formatRp(priceByDuration(prod, 7))}`, callback_data: `fastpanel_buy:${prod.id}:7` }]);
  }
  if (Number(prod.slot_monthly || prod.slot || 0) > 0) {
    kb.push([{ text: `30 Hari - ${fastpanelManager.formatRp(priceByDuration(prod, 30))}`, callback_data: `fastpanel_buy:${prod.id}:30` }]);
  }
  kb.push([{ text: '« Kembali', callback_data: 'fastpanel_order' }]);

  const provider = fastpanelManager.providerLabel(fastpanelManager.apiProviderKey(prod));
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    `⚡ *Pilih Masa Aktif Fastpanel*\n\nProvider: ${provider}\nSize: ${prod.size_slug}\nRAM: ${prod.ram}GB / ${prod.core} CORE`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
  );
}

async function orderFastpanel(bot, chatId, messageId, productId, durationDays = 30) {
  const prod = await fastpanelManager.getProduct(productId);
  const d = Number(durationDays) === 7 ? 7 : 30;
  if (!prod || Number(prod.status) !== 1) {
    return bot.sendMessage(chatId, '❌ Produk Fastpanel tidak ditemukan.');
  }
  if (slotByDuration(prod, d) <= 0) {
    return bot.sendMessage(chatId, `❌ Stok Fastpanel ${d} hari habis.`);
  }

  const price = priceByDuration(prod, d);
  if (!isAdmin(chatId)) {
    const bal = await getBalance(chatId);
    if (Number(bal || 0) < price) {
      return bot.sendMessage(chatId,
        `❌ Saldo tidak cukup.\nButuh: ${fastpanelManager.formatRp(price)}\nSaldo kamu: ${fastpanelManager.formatRp(bal || 0)}`
      );
    }
  }

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return bot.sendMessage(chatId, '❌ API cloud untuk produk ini tidak aktif atau tidak ditemukan.');

  const region = await pickRegionForToken(token);
  const image = ubuntuImageForToken(token);
  const providerKey = fastpanelManager.apiProviderKey({ token });
  const rootPassword = genPass(12);
  const fpPass = genFastpanelPass();
  const name = `fastpanel-${crypto.randomBytes(4).toString('hex')}`;

  // Reserve stock up-front to avoid double-purchase; restore on failure.
  await fastpanelManager.decrementStock(productId, d);
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `⏳ VPS Fastpanel sedang dibuat...\n\n` +
    `Provider: ${fastpanelManager.providerLabel(providerKey)}\n` +
    `Size: ${prod.size_slug}\n` +
    `Region: ${region}\n` +
    `Harga: ${fastpanelManager.formatRp(price)}\n` +
    `Masa aktif: ${d} hari\n\n` +
    `Estimasi total: ~15-20 menit sampai Fastpanel siap.`,
    { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] } }
  );

  let dropletId = null;
  try {
    const created = await createDroplet(token, name, region, prod.size_slug, image, rootCloudInit(rootPassword));
    dropletId = created.dropletId;
    if (!dropletId) throw new Error(created.error || 'Gagal membuat instance.');

    const ip = await waitPublicIp(token, dropletId, 40, 10000, region);
    if (!ip) throw new Error('IP publik VPS belum tersedia.');

    await bot.sendMessage(chatId, `✅ VPS berhasil dibuat: \`${ip}\`\n⏳ Menunggu SSH dan install Fastpanel...`, { parse_mode: 'Markdown' });

    const result = await installFastpanel(ip, 'root', rootPassword, {
      fastpanelUser: 'fastuser',
      fastpanelPassword: fpPass,
      sshMaxWaitMs: 12 * 60 * 1000
    }, (line) => {
      const s = String(line || '');
      if (/SUCCESS|PORT=|FP_USER=|FP_PASS=|FP_URL=|Failed|Error|❌|✅/.test(s)) {
        console.log(`[FASTPANEL ORDER ${ip}] ${s}`);
      }
    });

    if (!isAdmin(chatId)) await deductBalance(chatId, price);

    const now = Math.floor(Date.now() / 1000);
    await vpsManager.createVpsInstance({
      userId: chatId,
      apiId: prod.api_id,
      productId: prod.id,
      dropletId,
      ip,
      region,
      image: `fastpanel:${image}`,
      rootPassword,
      expiresAt: now + d * 86400,
      durationDays: d
    });

    await notifyFastpanelOrderSuccess(bot, {
      userId: chatId,
      ip,
      url: result.url,
      port: result.port,
      username: result.username,
      size: prod.size_slug,
      region,
      durationDays: d,
      price,
      apiId: prod.api_id,
      provider: providerKey
    });
    await notifyOrderTestimonial(bot, { productName: 'FASTPANEL' });

    return bot.sendMessage(chatId,
      `✅ *ORDER FASTPANEL SELESAI!*\n` +
      `🌐 URL   : ${result.url}\n` +
      `👤 User  : \`${result.username}\`\n` +
      `🔑 Pass  : \`${result.password}\`\n` +
      `🔒 Port  : ${result.port}\n` +
      `📝 IP VPS: \`${ip}\`\n` +
      `📝 SSH   : root / \`${rootPassword}\`\n` +
      `💰 Harga : ${fastpanelManager.formatRp(price)}\n` +
      `⏳ Masa aktif: ${d} hari\n\n` +
      `⚠️ Panel pakai SSL self-signed. Di browser klik "Advanced → Proceed".`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    // Rollback stock
    await fastpanelManager.incrementStock(productId, d);
    if (dropletId) {
      try { await deleteDroplet(token, dropletId, region); } catch (_) {}
    }
    return sendFailureReport(bot, chatId,
      `❌ Order Fastpanel gagal.\nSaldo tidak terpotong.\n`,
      e
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Admin                                                                     */
/* -------------------------------------------------------------------------- */

async function showAdminMenu(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;
  const kb = [
    [{ text: '➕ Tambah Spesifikasi Fastpanel', callback_data: 'fastpanel_admin_add' }],
    [{ text: '📋 List Spesifikasi Fastpanel', callback_data: 'fastpanel_admin_list' }],
    [{ text: '💲 Ubah Harga Fastpanel', callback_data: 'fastpanel_admin_price' }],
    [{ text: '🔥 Hapus Fastpanel Aktif', callback_data: 'fastpanel_admin_delete_instance' }],
    [{ text: '🗑️ Hapus Spesifikasi Fastpanel', callback_data: 'fastpanel_admin_delete' }],
    [{ text: '➖ Delete Stok Fastpanel', callback_data: 'fastpanel_admin_stock' }],
    [{ text: '💰 Ubah Harga Jasa Install', callback_data: 'fastpanel_admin_install_price' }],
    [{ text: '🏠 Kembali', callback_data: 'vps_admin' }]
  ];
  return safeMessageEditor.editMessage(bot, chatId, messageId, '⚡ *ADMIN FASTPANEL*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function pickApi(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;
  const apis = await fastpanelManager.listAllActiveApis();
  if (!apis.length) return bot.sendMessage(chatId, '❌ Belum ada API cloud aktif. Tambahkan API DigitalOcean/Linode/AWS dulu di menu VPS Admin.');

  const kb = apis.map(a => {
    const provider = fastpanelManager.providerLabel(fastpanelManager.apiProviderKey(a));
    const label = a.email ? `${provider} • ${a.email} • API#${a.id}` : `${provider} • API#${a.id}`;
    return ([{ text: label, callback_data: `fastpanel_add_api:${a.id}` }]);
  });
  kb.push([{ text: '« Kembali', callback_data: 'fastpanel_admin' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih API cloud untuk tambah spesifikasi Fastpanel:', { reply_markup: { inline_keyboard: kb } });
}

async function pickSize(bot, chatId, messageId, apiId, page = 0) {
  if (!isAdmin(chatId)) return;
  const token = await vpsManager.getDoApiToken(apiId);
  if (!token) return bot.sendMessage(chatId, '❌ Token API tidak ditemukan atau nonaktif.');
  const sizes = await getSizes(token);
  if (!sizes.length) return bot.sendMessage(chatId, '❌ Tidak ada size tersedia dari provider tersebut.');

  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(sizes.length / perPage));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const items = sizes.slice(safePage * perPage, safePage * perPage + perPage);

  const kb = items.map(s => ([{
    text: `${s.slug} (${Math.floor(Number(s.memory || 0) / 1024)}GB / ${s.vcpus} CORE) • $${Number(s.price_monthly || 0).toFixed(2)}/mo`,
    callback_data: `fastpanel_add_size:${apiId}:${s.slug}:${Math.floor(Number(s.memory || 0) / 1024)}:${s.vcpus}`
  }]));

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: `fastpanel_add_sizepage:${apiId}:${safePage - 1}` });
  nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `fastpanel_add_sizepage:${apiId}:${safePage + 1}` });
  kb.push(nav);
  kb.push([{ text: '« Kembali', callback_data: 'fastpanel_admin_add' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih spesifikasi untuk Fastpanel:', { reply_markup: { inline_keyboard: kb } });
}

async function promptAddPriceStock(bot, chatId, messageId, sessionManager, apiId, sizeSlug, ram, core) {
  if (!isAdmin(chatId)) return;
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `Masukkan harga dan stok Fastpanel.\n\nSpec: ${sizeSlug} (${ram}GB / ${core} CORE)\n` +
    `Format: \`harga_7hari stok_7hari harga_30hari stok_30hari\`\n` +
    `Contoh: \`50000 5 170000 5\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'fastpanel_admin_add' }]] } }
  );
  sessionManager.setAdminSession(chatId, {
    action: 'fastpanel_add_price_stock',
    apiId: Number(apiId),
    sizeSlug,
    ram: Number(ram),
    core: Number(core),
    messageId
  });
}

async function processAddPriceStock(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getAdminSession(chatId);
  if (!session || session.action !== 'fastpanel_add_price_stock') return false;
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
  const parts = String(msg.text || '').trim().split(/\s+/);
  if (parts.length !== 4 || parts.some(x => !/^[0-9]+$/.test(x))) {
    await bot.sendMessage(chatId, '❌ Format salah. Contoh: `50000 5 170000 5`', { parse_mode: 'Markdown' });
    return true;
  }
  await fastpanelManager.addProduct({
    apiId: session.apiId,
    sizeSlug: session.sizeSlug,
    ram: session.ram,
    core: session.core,
    priceWeekly: Number(parts[0]),
    stockWeekly: Number(parts[1]),
    price: Number(parts[2]),
    stock: Number(parts[3])
  });
  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId,
    `✅ Spesifikasi Fastpanel berhasil ditambahkan.\n` +
    `7 Hari : ${fastpanelManager.formatRp(parts[0])} | Stok ${parts[1]}\n` +
    `30 Hari: ${fastpanelManager.formatRp(parts[2])} | Stok ${parts[3]}`
  );
  return true;
}

async function listSpecs(bot, chatId, messageId, mode = 'list') {
  if (!isAdmin(chatId)) return;
  const rows = await fastpanelManager.listAllProducts();
  if (!rows.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '❌ Belum ada spesifikasi Fastpanel.',
      { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'fastpanel_admin' }]] } }
    );
  }

  if (mode === 'list') {
    const text = '📋 LIST SPESIFIKASI FASTPANEL\n\n' + rows.map((r, i) => {
      const provider = fastpanelManager.providerLabel(fastpanelManager.apiProviderKey(r));
      return `${i + 1}. #${r.id} ${provider} ${r.size_slug} (${r.ram}GB/${r.core}C)\n` +
             `   7H : ${fastpanelManager.formatRp(r.price_weekly || 0)} | Stok: ${r.slot_weekly || 0}\n` +
             `   30H: ${fastpanelManager.formatRp(r.price || 0)} | Stok: ${r.slot_monthly || r.slot || 0} | ${Number(r.status) === 1 ? 'Aktif' : 'Nonaktif'}`;
    }).join('\n');
    return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'fastpanel_admin' }]] } });
  }

  const prefix = mode === 'price'
    ? 'fastpanel_price_pick'
    : (mode === 'delete' ? 'fastpanel_delete_pick' : 'fastpanel_stock_pick');
  const kb = rows.map(r => {
    const provider = fastpanelManager.providerLabel(fastpanelManager.apiProviderKey(r));
    return ([{
      text: `#${r.id} ${provider} ${r.size_slug} • 7H ${fastpanelManager.formatRp(r.price_weekly || 0)} • 30H ${fastpanelManager.formatRp(r.price || 0)} • Stok ${r.slot_weekly || 0}/${r.slot_monthly || r.slot || 0}`,
      callback_data: `${prefix}:${r.id}`
    }]);
  });
  kb.push([{ text: '« Kembali', callback_data: 'fastpanel_admin' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih spesifikasi Fastpanel:', { reply_markup: { inline_keyboard: kb } });
}

async function promptSetPrice(bot, chatId, messageId, sessionManager, productId) {
  const prod = await fastpanelManager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `Masukkan harga baru Fastpanel.\n\nSpec: ${prod.size_slug}\nFormat: \`harga_7hari harga_30hari\`\nContoh: \`50000 170000\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'fastpanel_admin_price' }]] } }
  );
  sessionManager.setAdminSession(chatId, { action: 'fastpanel_set_price', productId: Number(productId), messageId });
}

async function processSetPrice(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getAdminSession(chatId);
  if (!session || session.action !== 'fastpanel_set_price') return false;
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
  const parts = String(msg.text || '').trim().split(/\s+/);
  if (parts.length !== 2 || parts.some(x => !/^[0-9]+$/.test(x))) {
    await bot.sendMessage(chatId, '❌ Format salah. Contoh: `50000 170000`', { parse_mode: 'Markdown' });
    return true;
  }
  await fastpanelManager.updateProductPrice(session.productId, Number(parts[1]), Number(parts[0]));
  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId,
    `✅ Harga Fastpanel berhasil diubah.\n7 Hari: ${fastpanelManager.formatRp(parts[0])}\n30 Hari: ${fastpanelManager.formatRp(parts[1])}`
  );
  return true;
}

async function deleteSpec(bot, chatId, messageId, productId) {
  await fastpanelManager.deleteProduct(productId);
  return bot.sendMessage(chatId,
    '✅ Spesifikasi Fastpanel berhasil dinonaktifkan dan stok dikosongkan.\n\n' +
    'Catatan: order lama tetap aman, jadi tidak error foreign key.'
  );
}

async function deleteStock(bot, chatId, messageId, productId) {
  const prod = await fastpanelManager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');

  const weeklyStock = Number(prod.slot_weekly || 0);
  const monthlyStock = Number(prod.slot_monthly || prod.slot || 0);
  const kb = [];

  if (weeklyStock > 0) kb.push([{ text: `➖ Kurangi stok 7 hari (${weeklyStock})`, callback_data: `fastpanel_stock_do:${productId}:7` }]);
  if (monthlyStock > 0) kb.push([{ text: `➖ Kurangi stok 30 hari (${monthlyStock})`, callback_data: `fastpanel_stock_do:${productId}:30` }]);
  kb.push([{ text: '« Kembali', callback_data: 'fastpanel_admin_stock' }]);

  const text =
    `📦 STOK FASTPANEL\n\n` +
    `ID: #${prod.id}\n` +
    `Spec: ${prod.size_slug}\n` +
    `7 Hari : ${weeklyStock}\n` +
    `30 Hari: ${monthlyStock}\n\n` +
    ((weeklyStock <= 0 && monthlyStock <= 0)
      ? 'Stok sudah kosong.'
      : 'Pilih stok yang ingin dikurangi:');

  return safeMessageEditor.editMessage(bot, chatId, messageId, text, { reply_markup: { inline_keyboard: kb } });
}

async function deleteStockDuration(bot, chatId, messageId, productId, durationDays) {
  await fastpanelManager.decrementStock(productId, Number(durationDays) === 7 ? 7 : 30);
  return bot.sendMessage(chatId, `✅ Stok Fastpanel ${Number(durationDays) === 7 ? 7 : 30} hari dikurangi 1.`);
}

async function listActiveFastpanelInstances(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;
  const rows = await fastpanelManager.listActiveFastpanelInstances();
  if (!rows.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Tidak ada Fastpanel aktif.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'fastpanel_admin' }]] }
    });
  }

  const kb = rows.slice(0, 40).map(r => ([{
    text: `${r.ip || '-'} | ${r.region || '-'} | UID ${r.user_id} | EXP ${fastpanelManager.formatDateShort(r.expires_at)}`,
    callback_data: `fastpanel_del_inst:${r.id}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'fastpanel_admin' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, '🔥 Pilih Fastpanel aktif yang ingin dihapus:', { reply_markup: { inline_keyboard: kb } });
}

async function deleteActiveFastpanel(bot, chatId, messageId, instanceId) {
  if (!isAdmin(chatId)) return;
  const inst = await fastpanelManager.getFastpanelInstance(instanceId);
  if (!inst) return bot.sendMessage(chatId, '❌ Fastpanel tidak ditemukan.');
  try {
    const token = await vpsManager.getDoApiTokenAny(inst.api_id);
    if (token && inst.droplet_id) await deleteDroplet(token, inst.droplet_id, inst.region || null);
  } catch (e) {
    console.error('Delete Fastpanel VPS error:', e.message || e);
  }
  await fastpanelManager.markFastpanelDeleted(instanceId);
  return bot.sendMessage(chatId, `✅ Fastpanel berhasil dihapus.\nIP: ${inst.ip || '-'}`);
}

async function promptSetInstallPrice(bot, chatId, messageId, sessionManager) {
  if (!isAdmin(chatId)) return;
  const current = await getInstallPrice();
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `Masukkan HARGA baru untuk *Jasa Install Fastpanel* (angka saja, contoh: \`15000\`).\n\nHarga saat ini: Rp ${current.toLocaleString('id-ID')}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'fastpanel_admin' }]] } }
  );
  sessionManager.setAdminSession(chatId, { action: 'fastpanel_set_install_price', messageId });
}

async function processSetInstallPrice(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getAdminSession(chatId);
  if (!session || session.action !== 'fastpanel_set_install_price') return false;
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
  const raw = String(msg.text || '').trim();
  if (!/^[0-9]+$/.test(raw)) {
    await bot.sendMessage(chatId, '❌ Harga harus angka saja.');
    return true;
  }
  await adminSettings.setSetting('fastpanel_install_price', Number(raw));
  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId, `✅ Harga Jasa Install Fastpanel berhasil diubah menjadi Rp ${Number(raw).toLocaleString('id-ID')}.`);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Expiry cleanup                                                            */
/* -------------------------------------------------------------------------- */

async function cleanupExpiredFastpanel(bot) {
  const rows = await fastpanelManager.listExpiredFastpanelInstances(25);
  if (!rows.length) return 0;

  let deleted = 0;
  for (const inst of rows) {
    try {
      const token = await vpsManager.getDoApiTokenAny(inst.api_id);
      if (token && inst.droplet_id) {
        try { await deleteDroplet(token, inst.droplet_id, inst.region || null); } catch (e) {
          console.error('Auto delete expired Fastpanel VPS error:', e.message || e);
        }
      }

      await fastpanelManager.markFastpanelDeleted(inst.id);
      deleted++;

      try {
        await bot.sendMessage(inst.user_id,
          `⌛ Fastpanel kamu sudah expired dan dihapus otomatis.\n\n` +
          `IP: ${inst.ip || '-'}\nExpired: ${fastpanelManager.formatDateShort(inst.expires_at)}`
        );
      } catch (_) {}

      await notifyFastpanelExpired(bot, {
        instanceId: inst.id,
        userId: inst.user_id,
        ip: inst.ip,
        region: inst.region
      });
    } catch (e) {
      console.error('cleanupExpiredFastpanel error:', e.message || e);
    }
  }
  return deleted;
}

function startFastpanelExpiryScheduler(bot) {
  const intervalMs = Number(process.env.FASTPANEL_EXPIRE_CHECK_MS || 5 * 60 * 1000);
  setTimeout(() => cleanupExpiredFastpanel(bot).catch(e => console.error('Fastpanel expiry first check error:', e.message || e)), 45 * 1000);
  setInterval(() => cleanupExpiredFastpanel(bot).catch(e => console.error('Fastpanel expiry check error:', e.message || e)), intervalMs);
  console.log(`Fastpanel expiry cleanup scheduled every ${Math.round(intervalMs / 1000)}s`);
}

module.exports = {
  showFastpanelMenu,
  startManualInstall,
  processManualInstall,
  showOrder,
  pickDuration,
  orderFastpanel,
  showAdminMenu,
  pickApi,
  pickSize,
  promptAddPriceStock,
  processAddPriceStock,
  listSpecs,
  promptSetPrice,
  processSetPrice,
  deleteSpec,
  deleteStock,
  deleteStockDuration,
  listActiveFastpanelInstances,
  deleteActiveFastpanel,
  promptSetInstallPrice,
  processSetInstallPrice,
  cleanupExpiredFastpanel,
  startFastpanelExpiryScheduler
};
