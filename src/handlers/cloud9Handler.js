const crypto = require('crypto');
const { isAdmin, getBalance, deductBalance, addBalance } = require('../utils/userManager');
const safeMessageEditor = require('../utils/safeMessageEdit');
const cloud9Manager = require('../utils/cloud9Manager');
const adminSettings = require('../utils/adminSettings');
const { getSizes, createDroplet, waitPublicIp, deleteDroplet, isUpCloudToken } = require('../utils/doApi');
const vpsManager = require('../utils/vpsManager');
const { installCloud9 } = require('../utils/cloud9Installer');
const { notifyCloud9OrderSuccess, notifyCloud9Expired, notifyOrderTestimonial } = require('../utils/orderNotifier');

function genPass(n = 18) {
  const raw = crypto.randomBytes(48).toString('base64').replace(/[\/+=]/g, '');
  return `${raw.slice(0, Math.max(12, Number(n) || 18))}-CLOUD9-143`;
}

/**
 * Send a failure report to the user. If the log is short, sent as a single
 * Telegram message. If longer than 3500 chars, sent as an attached .log
 * file so the full diagnostic dump (apt errors, wget URLs tried, script
 * step tail) survives Telegram's 4096-char message limit. Applied to both
 * manual install and auto-order flows.
 */
async function sendCloud9FailureReport(bot, chatId, prefix, err) {
  const raw = String(err?.message || err || 'unknown error');
  if (raw.length <= 3500) {
    return bot.sendMessage(chatId, `${prefix}Reason:\n${raw}`);
  }
  const summary = raw.split('\n').slice(0, 15).join('\n');
  try {
    await bot.sendMessage(chatId,
      `${prefix}Reason (log lengkap dilampirkan sebagai file):\n\n${summary}\n...\n(lihat file berisi tail log lengkap)`
    );
    return await bot.sendDocument(chatId, Buffer.from(raw, 'utf8'), {}, {
      filename: `cloud9-install-fail-${Date.now()}.log`,
      contentType: 'text/plain'
    });
  } catch (_) {
    return bot.sendMessage(chatId, `${prefix}Reason:\n${raw.slice(0, 3500)}`);
  }
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
  return await adminSettings.getNumber('cloud9_install_price', 10000);
}

function priceByDuration(prod, durationDays) {
  return Number(durationDays) === 7 ? Number(prod.price_weekly || prod.price || 170000) : Number(prod.price || prod.price_monthly || 170000);
}

function slotByDuration(prod, durationDays) {
  return Number(durationDays) === 7 ? Number(prod.slot_weekly || 0) : Number(prod.slot_monthly || prod.slot || 0);
}

async function showCloud9Menu(bot, chatId, messageId) {
  const installPrice = await getInstallPrice();
  const kb = [
    [{ text: `🛠️ Jasa Install Cloud9 - Rp ${installPrice.toLocaleString('id-ID')}`, callback_data: 'cloud9_install' }],
    [{ text: '☁️ Order Cloud9', callback_data: 'cloud9_order' }],
    [{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]
  ];
  return safeMessageEditor.editMessage(bot, chatId, messageId, '☁️ *MENU CLOUD9*\n\nPilih layanan Cloud9:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function startManualInstall(bot, chatId, messageId, sessionManager) {
  const price = await getInstallPrice();
  if (!isAdmin(chatId)) {
    const bal = await getBalance(chatId);
    if (Number(bal || 0) < price) {
      return safeMessageEditor.editMessage(bot, chatId, messageId, `❌ Saldo tidak cukup.\nButuh: Rp ${price.toLocaleString('id-ID')}`, {
        reply_markup: { inline_keyboard: [[{ text: '💳 Deposit', callback_data: 'deposit' }], [{ text: '« Kembali', callback_data: 'cloud9_menu' }]] }
      });
    }
  }

  const msg = await safeMessageEditor.editMessage(bot, chatId, messageId,
    `🛠️ *Jasa Install Cloud9*\n\nHarga: Rp ${price.toLocaleString('id-ID')}\nPort: 8000\nPastikan vps mu support untuk CLOUD9\n\nKirim IP VPS:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'cancel_installation' }]] } }
  );

  sessionManager.setUserSession(chatId, {
    installType: 'cloud9_manual',
    step: 'waiting_ip',
    messageId: msg?.message_id || messageId,
    price
  });
}

async function processManualInstall(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getUserSession(chatId);
  if (!session || session.installType !== 'cloud9_manual') return false;

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

    const status = await bot.sendMessage(chatId, '⏳ Instalasi Cloud9 dimulai. Mohon tunggu ±10-20 menit...');
    try {
      const result = await installCloud9(session.ip, session.username, session.password, {}, (line) => {
        const s = String(line || '');
        if (/SUCCESS|PORT=|C9_USER=|C9_PASS=|Failed|Error|❌|✅/.test(s)) console.log(`[CLOUD9 ${session.ip}] ${s}`);
      });

      await bot.sendMessage(chatId,
        `✅ *INSTALL CLOUD9 SELESAI!*\n` +
        `🌐 URL: http://${session.ip}:${result.port}\n` +
        `👤 Username: ${result.username}\n` +
        `🔑 Password: ${result.password}\n` +
        `💰 Harga: Rp ${Number(session.price).toLocaleString('id-ID')}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      if (!isAdmin(chatId)) {
        try { await addBalance(chatId, Number(session.price)); } catch (_) {}
      }
      await sendCloud9FailureReport(bot, chatId,
        `❌ Install Cloud9 gagal.\nSaldo dikembalikan jika sempat terpotong.\n`,
        e
      );
    }
    try { await bot.deleteMessage(chatId, status.message_id); } catch (_) {}
    return true;
  }

  return true;
}

async function showOrder(bot, chatId, messageId) {
  const products = await cloud9Manager.listActiveProducts();
  if (!products.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Stok Cloud9 kosong.\n\nHubungi admin untuk menambahkan spesifikasi Cloud9.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'cloud9_menu' }]] }
    });
  }

  const kb = products.slice(0, 30).map(p => ([{
    text: `RAM ${p.ram}GB / ${p.core} CORE • 7H ${cloud9Manager.formatRp(p.price_weekly || p.price)} • 30H ${cloud9Manager.formatRp(p.price || 170000)} • Stok ${Number(p.slot_weekly || 0)}/${Number(p.slot_monthly || p.slot || 0)}`,
    callback_data: `cloud9_pick:${p.id}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'cloud9_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '☁️ *ORDER CLOUD9*\n\nPilih spesifikasi:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function pickDuration(bot, chatId, messageId, productId) {
  const prod = await cloud9Manager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk Cloud9 tidak ditemukan.');

  const kb = [];
  if (Number(prod.slot_weekly || 0) > 0) kb.push([{ text: `7 Hari - ${cloud9Manager.formatRp(priceByDuration(prod, 7))}`, callback_data: `cloud9_buy:${prod.id}:7` }]);
  if (Number(prod.slot_monthly || prod.slot || 0) > 0) kb.push([{ text: `30 Hari - ${cloud9Manager.formatRp(priceByDuration(prod, 30))}`, callback_data: `cloud9_buy:${prod.id}:30` }]);
  kb.push([{ text: '« Kembali', callback_data: 'cloud9_order' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId,
    `☁️ *Pilih Masa Aktif Cloud9*\n\nSize: ${prod.size_slug}\nRAM: ${prod.ram}GB / ${prod.core} CORE`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
  );
}

async function orderCloud9(bot, chatId, messageId, productId, durationDays = 30) {
  const prod = await cloud9Manager.getProduct(productId);
  const d = Number(durationDays) === 7 ? 7 : 30;
  if (!prod || Number(prod.status) !== 1) return bot.sendMessage(chatId, '❌ Produk Cloud9 tidak ditemukan.');
  if (slotByDuration(prod, d) <= 0) return bot.sendMessage(chatId, `❌ Stok Cloud9 ${d} hari habis.`);

  const price = priceByDuration(prod, d);
  if (!isAdmin(chatId)) {
    const bal = await getBalance(chatId);
    if (Number(bal || 0) < price) {
      return bot.sendMessage(chatId, `❌ Saldo tidak cukup.\nButuh: ${cloud9Manager.formatRp(price)}\nSaldo kamu: ${cloud9Manager.formatRp(bal || 0)}`);
    }
  }

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token || !String(token).startsWith('aws:')) return bot.sendMessage(chatId, '❌ Produk Cloud9 harus memakai API AWS.');

  const region = (prod.token && String(prod.token).split('|')[2]) || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const rootPassword = genPass(12);
  const image = 'ubuntu-22.04';
  const name = `cloud9-${crypto.randomBytes(4).toString('hex')}`;

  await cloud9Manager.decrementStock(productId, d);
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `⏳ Cloud9 sedang dibuat...\n\nSize: ${prod.size_slug}\nRegion: ${region}\nHarga: ${cloud9Manager.formatRp(price)}\nMasa aktif: ${d} hari\n\nMohon tunggu sampai instalasi selesai.`,
    { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] } }
  );

  let dropletId = null;
  try {
    const created = await createDroplet(token, name, region, prod.size_slug, image, rootCloudInit(rootPassword));
    dropletId = created.dropletId;
    if (!dropletId) throw new Error(created.error || 'Gagal membuat instance.');

    const ip = await waitPublicIp(token, dropletId, 40, 10000, region);
    if (!ip) throw new Error('IP publik vps belum tersedia.');

    await bot.sendMessage(chatId, `✅ VPS sedang dibuat: ${ip}\n⏳ Menunggu SSH dan install Cloud9...`);

    // Cloud9 UpCloud pakai port 8880 (open di firewall default UpCloud),
    // provider lain 8000.
    const c9Port = isUpCloudToken(token) ? 8880 : 8000;
    const result = await installCloud9(ip, 'root', rootPassword, { sshMaxWaitMs: 12 * 60 * 1000, cloud9Port: c9Port }, (line) => {
      const s = String(line || '');
      if (/SUCCESS|PORT=|C9_USER=|C9_PASS=|Failed|Error|❌|✅/.test(s)) console.log(`[CLOUD9 ORDER ${ip}] ${s}`);
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
      image: 'cloud9:ubuntu-22.04',
      rootPassword,
      expiresAt: now + d * 86400,
      durationDays: d
    });

    await notifyCloud9OrderSuccess(bot, {
      userId: chatId,
      ip,
      url: `http://${ip}:${result.port}`,
      port: result.port,
      size: prod.size_slug,
      region,
      durationDays: d,
      price,
      apiId: prod.api_id
    });
    await notifyOrderTestimonial(bot, { productName: 'CLOUD9' });

    await notifyCloud9OrderSuccess(bot, {
      userId: chatId,
      ip,
      url: `http://${ip}:${result.port}`,
      port: result.port,
      size: prod.size_slug,
      region,
      durationDays: d,
      price,
      apiId: prod.api_id
    });
    await notifyOrderTestimonial(bot, { productName: 'CLOUD9' });

    return bot.sendMessage(chatId,
      `✅ *ORDER CLOUD9 SELESAI!*\n` +
      `🌐 URL: http://${ip}:${result.port}\n` +
      `👤 Username: ${result.username}\n` +
      `🔑 Password: ${result.password}\n` +
      `💰 Harga: ${cloud9Manager.formatRp(price)}\n` +
      `⏳ Masa aktif: ${d} hari`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await cloud9Manager.incrementStock(productId, d);
    if (dropletId) {
      try { await deleteDroplet(token, dropletId, region); } catch (_) {}
    }
    return sendCloud9FailureReport(bot, chatId,
      `❌ Order Cloud9 gagal.\n`,
      e
    );
  }
}

async function showAdminMenu(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;
  const kb = [
    [{ text: '➕ Tambah Spesifikasi Cloud9 (AWS / UpCloud)', callback_data: 'cloud9_admin_add' }],
    [{ text: '📋 List Spesifikasi Cloud9', callback_data: 'cloud9_admin_list' }],
    [{ text: '💲 Ubah Harga Cloud9', callback_data: 'cloud9_admin_price' }],
    [{ text: '🔥 Hapus Cloud9 Aktif', callback_data: 'cloud9_admin_delete_instance' }],
    [{ text: '🗑️ Hapus Spesifikasi Cloud9', callback_data: 'cloud9_admin_delete' }],
    [{ text: '➖ Delete Stok Cloud9', callback_data: 'cloud9_admin_stock' }],
    [{ text: '🏠 Kembali', callback_data: 'vps_admin' }]
  ];
  return safeMessageEditor.editMessage(bot, chatId, messageId, '☁️ *ADMIN CLOUD9*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function pickAwsApi(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;
  const apis = await cloud9Manager.listAwsApis();
  if (!apis.length) return bot.sendMessage(chatId, '❌ Belum ada API AWS aktif. Tambahkan API AWS dulu.');
  const kb = apis.map(a => ([{ text: a.email ? `${a.email} - API#${a.id}` : `${(a.provider || 'AWS')} API#${a.id}`, callback_data: `cloud9_add_api:${a.id}` }]));
  kb.push([{ text: '« Kembali', callback_data: 'cloud9_admin' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih API AWS untuk tambah spesifikasi Cloud9:', { reply_markup: { inline_keyboard: kb } });
}

async function pickSize(bot, chatId, messageId, apiId, page = 0) {
  if (!isAdmin(chatId)) return;
  const token = await vpsManager.getDoApiToken(apiId);
  if (!token) return bot.sendMessage(chatId, '❌ Token API tidak ditemukan.');
  const sizes = await getSizes(token);
  if (!sizes.length) return bot.sendMessage(chatId, '❌ Tidak ada size AWS tersedia.');

  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(sizes.length / perPage));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const items = sizes.slice(safePage * perPage, safePage * perPage + perPage);

  const kb = items.map(s => ([{
    text: `${s.slug} (${Math.floor(Number(s.memory || 0) / 1024)}GB / ${s.vcpus} CORE) • $${Number(s.price_monthly || 0).toFixed(2)}/mo`,
    callback_data: `cloud9_add_size:${apiId}:${s.slug}:${Math.floor(Number(s.memory || 0) / 1024)}:${s.vcpus}`
  }]));

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Halaman sebelumnya', callback_data: `cloud9_add_sizepage:${apiId}:${safePage - 1}` });
  nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) nav.push({ text: '➡️ Halaman berikutnya', callback_data: `cloud9_add_sizepage:${apiId}:${safePage + 1}` });
  kb.push(nav);
  kb.push([{ text: '« Kembali', callback_data: 'cloud9_admin_add' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih spesifikasi AWS untuk Cloud9:', { reply_markup: { inline_keyboard: kb } });
}

async function promptAddPriceStock(bot, chatId, messageId, sessionManager, apiId, sizeSlug, ram, core) {
  if (!isAdmin(chatId)) return;
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `Masukkan harga dan stok Cloud9.\n\nSpec: ${sizeSlug} (${ram}GB / ${core} CORE)\nFormat: \`harga_7hari stok_7hari harga_30hari stok_30hari\`\nContoh: \`50000 5 170000 5\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'cloud9_admin_add' }]] } }
  );
  sessionManager.setAdminSession(chatId, { action: 'cloud9_add_price_stock', apiId: Number(apiId), sizeSlug, ram: Number(ram), core: Number(core), messageId });
}

async function processAddPriceStock(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getAdminSession(chatId);
  if (!session || session.action !== 'cloud9_add_price_stock') return false;
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
  const parts = String(msg.text || '').trim().split(/\s+/);
  if (parts.length !== 4 || parts.some(x => !/^[0-9]+$/.test(x))) {
    await bot.sendMessage(chatId, '❌ Format salah. Contoh: `50000 5 170000 5`', { parse_mode: 'Markdown' });
    return true;
  }
  await cloud9Manager.addProduct({
    apiId: session.apiId, sizeSlug: session.sizeSlug, ram: session.ram, core: session.core,
    priceWeekly: Number(parts[0]), stockWeekly: Number(parts[1]), price: Number(parts[2]), stock: Number(parts[3])
  });
  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId, `✅ Spesifikasi Cloud9 berhasil ditambahkan.\n7 Hari: ${cloud9Manager.formatRp(parts[0])} | Stok ${parts[1]}\n30 Hari: ${cloud9Manager.formatRp(parts[2])} | Stok ${parts[3]}`);
  return true;
}

async function listSpecs(bot, chatId, messageId, mode = 'list') {
  if (!isAdmin(chatId)) return;
  const rows = await cloud9Manager.listAllProducts();
  if (!rows.length) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Belum ada spesifikasi Cloud9.', { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'cloud9_admin' }]] } });

  if (mode === 'list') {
    const text = '📋 LIST SPESIFIKASI CLOUD9\n\n' + rows.map((r, i) =>
      `${i + 1}. #${r.id} ${r.size_slug} (${r.ram}GB/${r.core}C)\n   7H: ${cloud9Manager.formatRp(r.price_weekly || 0)} | Stok: ${r.slot_weekly || 0}\n   30H: ${cloud9Manager.formatRp(r.price || 0)} | Stok: ${r.slot_monthly || r.slot || 0} | ${Number(r.status) === 1 ? 'Aktif' : 'Nonaktif'}`
    ).join('\n');
    return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'cloud9_admin' }]] } });
  }

  const prefix = mode === 'price' ? 'cloud9_price_pick' : (mode === 'delete' ? 'cloud9_delete_pick' : 'cloud9_stock_pick');
  const kb = rows.map(r => ([{
    text: `#${r.id} ${r.size_slug} • 7H ${cloud9Manager.formatRp(r.price_weekly || 0)} • 30H ${cloud9Manager.formatRp(r.price || 0)} • Stok ${r.slot_weekly || 0}/${r.slot_monthly || r.slot || 0}`,
    callback_data: `${prefix}:${r.id}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'cloud9_admin' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih spesifikasi Cloud9:', { reply_markup: { inline_keyboard: kb } });
}

async function promptSetPrice(bot, chatId, messageId, sessionManager, productId) {
  const prod = await cloud9Manager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');
  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `Masukkan harga baru Cloud9.\n\nSpec: ${prod.size_slug}\nFormat: \`harga_7hari harga_30hari\`\nContoh: \`50000 170000\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'cloud9_admin_price' }]] } }
  );
  sessionManager.setAdminSession(chatId, { action: 'cloud9_set_price', productId: Number(productId), messageId });
}

async function processSetPrice(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getAdminSession(chatId);
  if (!session || session.action !== 'cloud9_set_price') return false;
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
  const parts = String(msg.text || '').trim().split(/\s+/);
  if (parts.length !== 2 || parts.some(x => !/^[0-9]+$/.test(x))) {
    await bot.sendMessage(chatId, '❌ Format salah. Contoh: `50000 170000`', { parse_mode: 'Markdown' });
    return true;
  }
  await cloud9Manager.updateProductPrice(session.productId, Number(parts[1]), Number(parts[0]));
  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId, `✅ Harga Cloud9 berhasil diubah.\n7 Hari: ${cloud9Manager.formatRp(parts[0])}\n30 Hari: ${cloud9Manager.formatRp(parts[1])}`);
  return true;
}

async function deleteSpec(bot, chatId, messageId, productId) {
  await cloud9Manager.deleteProduct(productId);
  return bot.sendMessage(chatId, '✅ Spesifikasi Cloud9 berhasil dinonaktifkan dan stok dikosongkan.\n\nCatatan: data order lama tetap aman, jadi tidak error foreign key.');
}

async function deleteStock(bot, chatId, messageId, productId) {
  const prod = await cloud9Manager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');

  const weeklyStock = Number(prod.slot_weekly || 0);
  const monthlyStock = Number(prod.slot_monthly || prod.slot || 0);
  const kb = [];

  if (weeklyStock > 0) kb.push([{ text: `➖ Kurangi stok 7 hari (${weeklyStock})`, callback_data: `cloud9_stock_do:${productId}:7` }]);
  if (monthlyStock > 0) kb.push([{ text: `➖ Kurangi stok 30 hari (${monthlyStock})`, callback_data: `cloud9_stock_do:${productId}:30` }]);

  kb.push([{ text: '« Kembali', callback_data: 'cloud9_admin_stock' }]);

  const text =
    `📦 STOK CLOUD9\n\n` +
    `ID: #${prod.id}\n` +
    `Spec: ${prod.size_slug}\n` +
    `7 Hari: ${weeklyStock}\n` +
    `30 Hari: ${monthlyStock}\n\n` +
    (weeklyStock <= 0 && monthlyStock <= 0
      ? 'Stok sudah kosong, tidak ada yang bisa dikurangi.'
      : 'Pilih stok yang ingin dikurangi:');

  return safeMessageEditor.editMessage(bot, chatId, messageId, text, { reply_markup: { inline_keyboard: kb } });
}

async function deleteStockDuration(bot, chatId, messageId, productId, durationDays) {
  await cloud9Manager.decrementStock(productId, Number(durationDays) === 7 ? 7 : 30);
  return bot.sendMessage(chatId, `✅ Stok Cloud9 ${Number(durationDays) === 7 ? 7 : 30} hari dikurangi 1.`);
}

async function listActiveCloud9Instances(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;
  const rows = await cloud9Manager.listActiveCloud9Instances();
  if (!rows.length) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Tidak ada Cloud9 aktif.', { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'cloud9_admin' }]] } });

  const kb = rows.slice(0, 40).map(r => ([{
    text: `${r.ip || '-'} | ${r.region || '-'} | UID ${r.user_id} | EXP ${cloud9Manager.formatDateShort(r.expires_at)}`,
    callback_data: `cloud9_del_inst:${r.id}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'cloud9_admin' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, '🔥 Pilih Cloud9 aktif yang ingin dihapus:', { reply_markup: { inline_keyboard: kb } });
}

async function deleteActiveCloud9(bot, chatId, messageId, instanceId) {
  if (!isAdmin(chatId)) return;
  const inst = await cloud9Manager.getCloud9Instance(instanceId);
  if (!inst) return bot.sendMessage(chatId, '❌ Cloud9 tidak ditemukan.');
  try {
    const token = await vpsManager.getDoApiToken(inst.api_id);
    if (token && inst.droplet_id) await deleteDroplet(token, inst.droplet_id, inst.region || null);
  } catch (e) {
    console.error('Delete Cloud9 AWS error:', e.message || e);
  }
  await cloud9Manager.markCloud9Deleted(instanceId);
  return bot.sendMessage(chatId, `✅ Cloud9 berhasil dihapus.\nIP: ${inst.ip || '-'}`);
}

async function cleanupExpiredCloud9(bot) {
  const rows = await cloud9Manager.listExpiredCloud9Instances(25);
  if (!rows.length) return 0;

  let deleted = 0;
  for (const inst of rows) {
    try {
      const token = await vpsManager.getDoApiToken(inst.api_id);
      if (token && inst.droplet_id) {
        try { await deleteDroplet(token, inst.droplet_id, inst.region || null); } catch (e) {
          console.error('Auto delete expired Cloud9 AWS error:', e.message || e);
        }
      }

      await cloud9Manager.markCloud9Deleted(inst.id);
      deleted++;

      try {
        await bot.sendMessage(inst.user_id, `⌛ Cloud9 kamu sudah expired dan dihapus otomatis.\n\nIP: ${inst.ip || '-'}\nExpired: ${cloud9Manager.formatDateShort(inst.expires_at)}`);
      } catch (_) {}

      await notifyCloud9Expired(bot, {
        instanceId: inst.id,
        userId: inst.user_id,
        ip: inst.ip,
        region: inst.region
      });
    } catch (e) {
      console.error('cleanupExpiredCloud9 error:', e.message || e);
    }
  }
  return deleted;
}

function startCloud9ExpiryScheduler(bot) {
  const intervalMs = Number(process.env.CLOUD9_EXPIRE_CHECK_MS || 5 * 60 * 1000);
  setTimeout(() => cleanupExpiredCloud9(bot).catch(e => console.error('Cloud9 expiry first check error:', e.message || e)), 30 * 1000);
  setInterval(() => cleanupExpiredCloud9(bot).catch(e => console.error('Cloud9 expiry check error:', e.message || e)), intervalMs);
  console.log(`Cloud9 expiry cleanup scheduled every ${Math.round(intervalMs / 1000)}s`);
}


module.exports = {
  showCloud9Menu, startManualInstall, processManualInstall, showOrder, pickDuration, orderCloud9,
  showAdminMenu, pickAwsApi, pickSize, promptAddPriceStock, processAddPriceStock, listSpecs,
  promptSetPrice, processSetPrice, deleteSpec, deleteStock, deleteStockDuration,
  listActiveCloud9Instances, deleteActiveCloud9,
  cleanupExpiredCloud9, startCloud9ExpiryScheduler
};
