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

const crypto = require('crypto');
const net = require('net');
const { Client } = require('ssh2');
const { isAdmin, getBalance, deductBalance } = require('../utils/userManager');
const { getRegions, getImages, createDroplet, waitPublicIp, deleteDroplet, isLinodeToken, linodeSetDirectDisk } = require('../utils/doApi');
const vpsManager = require('../utils/vpsManager');
const backupManager = require('../utils/backupManager');
const { notifyOrderSuccess, notifyOrderTestimonial } = require('../utils/orderNotifier');
const safeMessageEditor = require('../utils/safeMessageEdit');
const {
  RDP_MONITOR_TIMEOUT_MS,
  buildTimeoutCardMarkdown,
  buildTimeoutCardKeyboard,
  validateWindowsPassword
} = require('../utils/rdpPasswordUtil');

// Poll a TCP port until it accepts a connection. Same pattern used by
// rdpOrderHandler.js / renterHandler.js — kept local here to avoid
// widening a shared module in a small bugfix PR.
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
    if (await tryOnce()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function genPass(n = 18) {
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

async function showProducts(bot, chatId, messageId) {
  // Show a single row per spec (ram/core/price) by aggregating slots across all active DO APIs.
  const products = await vpsManager.listActiveProductGroups('vps');

  if (!products.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Produk VPS kosong.\n\nHubungi admin untuk menambahkan produk.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]] }
    });
  }

  // Step 1: user memilih spesifikasi saja (tanpa info durasi/harga/stok)
  // Info durasi/harga/stok akan ditampilkan pada step berikutnya (pemilihan durasi).
  const kb = products.map(p => ([{
    text: `RAM ${Number(p.ram)}GB / ${Number(p.core)} CORE`,
    callback_data: `vps_buygrp:${Number(p.ram)}:${Number(p.core)}`
  }]));

  kb.push([{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '🖥️ *ORDER VPS*\n\nPilih paket VPS:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

// When user selects a grouped spec, pick an underlying product row (API) with available slot.
async function pickProductGroup(bot, chatId, messageId, ram, core) {
  // Show duration picker (Harian / Mingguan)
  const group = (await vpsManager.listActiveProductGroups('vps')).find(g => Number(g.ram) === Number(ram) && Number(g.core) === Number(core));
  if (!group) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Produk tidak ditemukan atau slot habis. Silakan pilih ulang dari daftar terbaru.', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'order_vps' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
  });

  const kb = [];
  if (group.price_daily != null && Number(group.slot_daily || 0) > 0) {
    kb.push([{ text: `🗓️ Harian • Rp${Number(group.price_daily).toLocaleString()} (stok ${Number(group.slot_daily || 0)})`, callback_data: `vps_buydur:${ram}:${core}:1` }]);
  }
  if (group.price_weekly != null && Number(group.slot_weekly || 0) > 0) {
    kb.push([{ text: `🗓️ Mingguan (7 hari) • Rp${Number(group.price_weekly).toLocaleString()} (stok ${Number(group.slot_weekly || 0)})`, callback_data: `vps_buydur:${ram}:${core}:7` }]);
  }
  if (group.price_monthly != null && Number(group.slot_monthly || 0) > 0) {
    kb.push([{ text: `🗓️ Bulanan (30 hari) • Rp${Number(group.price_monthly).toLocaleString()} (stok ${Number(group.slot_monthly || 0)})`, callback_data: `vps_buydur:${ram}:${core}:30` }]);
  }
  kb.push([{ text: '« Kembali', callback_data: 'order_vps' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ *Pilih Durasi VPS*', {
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
  const providers = await vpsManager.listActiveProductProviders('vps', ram, core, durationDays);
  if (!providers.length) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Produk tidak ditemukan atau slot habis untuk durasi ini.', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'order_vps' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
  });
  const kb = providers.map(p => ([{ text: `${providerButtonLabel(p.provider)} • Rp${Number(p.price || 0).toLocaleString('id-ID')} • Stok ${Number(p.slot || 0)}`, callback_data: `vps_buyprov:${ram}:${core}:${durationDays}:${p.provider}` }]));
  kb.push([{ text: '« Kembali', callback_data: `vps_buygrp:${ram}:${core}` }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, '☁️ *Pilih Provider VPS*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

async function pickProductByProvider(bot, chatId, messageId, ram, core, durationDays = 7, provider = 'all') {
  const prod = await vpsManager.getAvailableProductBySpecDurationProvider('vps', ram, core, durationDays, provider);
  if (!prod) return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Produk/provider tidak ditemukan atau slot habis.', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: `vps_buydur:${ram}:${core}:${durationDays}` }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
  });
  return pickProduct(bot, chatId, messageId, prod.id, durationDays);
}

async function pickProduct(bot, chatId, messageId, productId, durationDays = 7) {
  const prod = await vpsManager.getProduct(productId);
  if (!prod) {
    return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');
  }

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) {
    return bot.sendMessage(chatId, '❌ API cloud tidak ditemukan. Hubungi admin.');
  }

  const regions = await getRegions(token);
  if (!regions.length) {
    return bot.sendMessage(chatId, '❌ Tidak ada region tersedia.');
  }

  const kb = regions.slice(0, 40).map(r => ([{
    text: `${r.slug} (${r.name})`,
    callback_data: `vps_reg:${productId}:${r.slug}:${durationDays}`
  }]));

  kb.push([{ text: '« Kembali', callback_data: 'order_vps' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '🌍 *Pilih Region VPS*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function pickRegion(bot, chatId, messageId, productId, regionSlug, durationDays = 7) {
  const prod = await vpsManager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return bot.sendMessage(chatId, '❌ API cloud tidak ditemukan.');

  const images = await getImages(token);
  if (!images.length) return bot.sendMessage(chatId, '❌ Tidak ada OS tersedia.');

  const kb = images.map(i => ([{
    text: i.label,
    callback_data: `vps_img:${productId}:${regionSlug}:${i.slug}:${durationDays}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'order_vps' }, { text: '🏠 Menu', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '💿 *Pilih OS*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function createVps(bot, chatId, messageId, productId, regionSlug, imageSlug, durationDays = 7) {
  const uid = chatId;

  const prod = await vpsManager.getProduct(productId);
  if (!prod) return bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');

  const d = Number(durationDays);
  const slotAvail = (d === 1) ? Number(prod.slot_daily || 0) : (d === 7 ? Number(prod.slot_weekly || 0) : Number(prod.slot_monthly || 0));
  if (slotAvail <= 0) return bot.sendMessage(chatId, '❌ Slot VPS habis untuk durasi yang dipilih.');

  // Check balance (admin unlimited)
  if (!isAdmin(uid)) {
    const bal = await getBalance(uid);
    const numericBal = typeof bal === 'string' ? 0 : Number(bal);
        const priceToCharge = (d === 1) ? Number(prod.price_daily) : (d === 7 ? Number(prod.price_weekly) : Number(prod.price));
    if (numericBal < priceToCharge) {
      return bot.sendMessage(chatId, '❌ Saldo tidak cukup. Silakan deposit terlebih dahulu.');
    }
  }

  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return bot.sendMessage(chatId, '❌ API cloud tidak ditemukan.');

  const password = genPass(12);

  const cloudInit = rootCloudInit(password);

  await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ VPS sedang dibuat, mohon tunggu...', {
    reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
  });

  const { dropletId, error } = await createDroplet(
    token,
    `vps-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex')}`,
    regionSlug,
    prod.size_slug,
    imageSlug,
    cloudInit
  );

  if (!dropletId) {
    return bot.sendMessage(chatId, `❌ Gagal membuat VPS\nReason: ${error}`);
  }

  const ip = await waitPublicIp(token, dropletId, 20, 10000, regionSlug);
  if (!ip) {
    // Clean up droplet to avoid stuck resources
    await deleteDroplet(token, dropletId, regionSlug);
    return bot.sendMessage(chatId, '⚠️ VPS dibuat tapi IP belum tersedia. Silakan coba lagi beberapa menit.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + (Number(durationDays) * 86400);

  await vpsManager.createVpsInstance({
    userId: uid,
    apiId: prod.api_id,
    productId: prod.id,
    dropletId,
    ip,
    region: regionSlug,
    image: imageSlug,
    rootPassword: password,
    expiresAt,
    durationDays: Number(durationDays)
  });

  // Deduct balance and slot
  if (!isAdmin(uid)) {
    const priceToCharge = (d === 1) ? Number(prod.price_daily) : (d === 7 ? Number(prod.price_weekly) : Number(prod.price));
    await deductBalance(uid, priceToCharge);
  }
  await vpsManager.decrementProductSlotDuration(prod.id, d);

  await bot.sendMessage(chatId,
    `━━━ VPS BERHASIL DIBUAT ━━━\n` +
    `⏳ Durasi : ${Number(durationDays)} hari\n` +
    `🗓️ Expired : ${new Date(expiresAt*1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB\n` +
    `📝 IP       : ${ip}\n` +
    `📝 USER     : root\n` +
    `📝 PASSWORD : ${password}\n` +
    `📝 OS       : ${imageSlug}\n` +
    `📝 REGION   : ${regionSlug}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚠️ Simpan data ini baik-baik.\n\n` +
    `Ketik /start untuk kembali ke menu.`,
  );

  await notifyOrderSuccess(bot, {
    type: 'VPS',
    ip,
    spec: `${prod.ram || ''}GB / ${prod.core || ''} CORE (${prod.size_slug})`.replace(/^GB \/  CORE /, '').trim(),
    apiId: prod.api_id,
    durationDays: Number(durationDays),
    price: (Number(durationDays) === 1 ? prod.price_daily : (Number(durationDays) === 7 ? prod.price_weekly : prod.price)),
    buyerId: uid
  });

  // Channel #2 (testimoni) - minimal, optional
  await notifyOrderTestimonial(bot, { productName: 'VPS' });

  return;
}

async function showMyServices(bot, chatId, messageId) {
  const allRows = await vpsManager.listUserVps(chatId);
  const rows = allRows.filter(r => {
    const img = String(r.image || '');
    const type = String(r.product_type || '').toLowerCase();
    return !img.startsWith('cloud9:') && type !== 'cloud9'
        && !img.startsWith('fastpanel:') && type !== 'fastpanel';
  });

  if (!rows.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Kamu belum punya VPS/RDP.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]] }
    });
  }

  const kb = rows.map(r => {
    const type = vpsManager.isRdpInstance(r) ? 'rdp' : 'vps';
    const ipText = r.ip ? (type === 'rdp' ? `${r.ip}:4443` : r.ip) : '-';
    const labelType = type === 'rdp' ? '🪟 RDP' : '🖥️ VPS';
    const size = r.size_slug ? ` | ${r.size_slug}` : '';
    return ([{
      text: `${labelType} | ${ipText}${size}`,
      callback_data: `srv_view:${r.id}`
    }]);
  });

  kb.push([{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]);

  return safeMessageEditor.editMessage(
    bot,
    chatId,
    messageId,
    '🖥️ *VPS&RDP MILIK KAMU*\n\nKlik untuk melihat detail & aksi:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
  );
}

// Backward compatibility
async function showMyVps(bot, chatId, messageId) {
  return showMyServices(bot, chatId, messageId);
}

async function viewMyService(bot, chatId, messageId, vpsId) {
  const vps = await vpsManager.getVpsInstance(vpsId);
  if (vps && (String(vps.image || '').startsWith('cloud9:') || String(vps.product_type || '').toLowerCase() === 'cloud9')) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '☁️ Cloud9 dikelola dari menu Admin Cloud9, bukan VPS&RDP Saya.', {
      reply_markup: { inline_keyboard: [[{ text: '☁️ Admin Cloud9', callback_data: 'cloud9_admin' }], [{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
    });
  }
  if (vps && (String(vps.image || '').startsWith('fastpanel:') || String(vps.product_type || '').toLowerCase() === 'fastpanel')) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '⚡ Fastpanel dikelola dari menu Fastpanel/Admin Fastpanel, bukan VPS&RDP Saya.', {
      reply_markup: { inline_keyboard: [[{ text: '⚡ Menu Fastpanel', callback_data: 'fastpanel_menu' }], [{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
    });
  }

  if (!vps || vps.status !== 1) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Data VPS/RDP tidak ditemukan.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
    });
  }

  if (!isAdmin(chatId) && vps.user_id !== chatId) {
    return bot.sendMessage(chatId, '❌ Akses ditolak.');
  }

  const type = vpsManager.isRdpInstance(vps) ? 'rdp' : 'vps';
  const ipText = vps.ip ? (type === 'rdp' ? `${vps.ip}:4443` : vps.ip) : '-';
  const size = vps.size_slug ? vps.size_slug : '-';
  const region = vps.region || '-';

  let extra = '';
  if (type === 'rdp') {
    const osVer = String(vps.image || '').startsWith('rdp:') ? vps.image.replace('rdp:', '') : '-';
    extra = `\n🪟 Windows: *${osVer}*\n🔒 Port RDP: *4443*\n👤 Username: *administrator*\n🔑 Password: _(hidden — klik tombol di bawah)_`;
  } else {
    extra = `\n🐧 Image: *${vps.image || '-'}*`;
  }

  const text =
`📄 *Detail ${type === 'rdp' ? 'RDP' : 'VPS'}*\n\n` +
`🆔 ID: *${vps.id}*\n` +
`🌍 Region: *${region}*\n` +
`📦 Size: *${size}*\n` +
`🌐 IP: *${ipText}*` +
`${extra}\n\n` +
`Pilih aksi di bawah ini:`;

  const actionRows = [];
  if (type === 'rdp') {
    // Password is hidden by default; user must explicitly opt-in to
    // reveal it. Keeps the credential off shoulder-surfers' screens
    // when the user is just browsing the menu.
    actionRows.push([{ text: '🔑 Lihat Password', callback_data: `view_rdp_pass:${vps.id}` }]);
    actionRows.push([{ text: '🔄 Rebuild RDP', callback_data: `srv_action:rebuild_rdp:${vps.id}` }]);
  } else {
    actionRows.push([{ text: '🔑 Reset Password', callback_data: `srv_action:reset_vps:${vps.id}` }]);
    actionRows.push([{ text: '🔄 Rebuild VPS', callback_data: `srv_action:rebuild_vps:${vps.id}` }]);
  }
  actionRows.push([{ text: '📦 Backup Data', callback_data: `backup_menu:${vps.id}` }]);
  if (type === 'rdp') {
    actionRows.push([{ text: '🔄 Restore Data RDP', callback_data: `backup_restore_ask:${vps.id}` }]);
  } else {
    actionRows.push([{ text: '🔄 Restore Data VPS', callback_data: `backup_restore_ask:${vps.id}` }]);
  }
  actionRows.push([{ text: '🗑️ Hapus', callback_data: `srv_action:delete:${vps.id}` }]);
  actionRows.push([{ text: '« Kembali', callback_data: 'my_services' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: actionRows }
  });
}

/**
 * Reveal the stored RDP password for an instance. Called from the "🔑
 * Lihat Password" button in viewMyService. Reads the current password
 * from vps_instances.password (which is now always populated because
 * updateVpsInstancePassword is called BEFORE the install monitor).
 *
 * Displays a card with the credentials + Copy buttons + a "Sembunyikan"
 * toggle that navigates back to viewMyService (which re-hides).
 */
async function showRdpPassword(bot, chatId, messageId, vpsId) {
  const vps = await vpsManager.getVpsInstance(vpsId);
  if (!vps || vps.status !== 1) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Data RDP tidak ditemukan.', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
    });
  }
  if (!isAdmin(chatId) && vps.user_id !== chatId) {
    return bot.sendMessage(chatId, '❌ Akses ditolak.');
  }
  if (!vpsManager.isRdpInstance(vps)) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Ini bukan RDP.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: `srv_view:${vps.id}` }]] }
    });
  }

  const pass = vps.password || vps.root_password || null;
  if (!pass) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '⚠️ Password RDP tidak tersimpan di database.\n\n' +
      'Kemungkinan RDP ini dibuat dengan versi bot lama. Rebuild RDP untuk generate password baru yang akan tersimpan otomatis.',
      { reply_markup: { inline_keyboard: [
        [{ text: '🔄 Rebuild RDP', callback_data: `srv_action:rebuild_rdp:${vps.id}` }],
        [{ text: '« Kembali', callback_data: `srv_view:${vps.id}` }]
      ] } }
    );
  }

  const ipText = vps.ip ? `${vps.ip}:4443` : '-';
  const bt = '`';
  const text =
    `🔑 *Password RDP*\n\n` +
    `🌐 Server: ${bt}${ipText}${bt}\n` +
    `👤 Username: ${bt}administrator${bt}\n` +
    `🔑 Password: ${bt}${pass}${bt}\n\n` +
    `_Tekan tombol Copy untuk salin, atau Sembunyikan untuk kembali._`;

  return safeMessageEditor.editMessage(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Copy Password', callback_data: `copy_pass_${pass}` }],
        [{ text: '📋 Copy Server', callback_data: `copy_server_${vps.ip}:4443` }],
        [{ text: '🙈 Sembunyikan', callback_data: `srv_view:${vps.id}` }]
      ]
    }
  });
}

async function confirmServiceAction(bot, chatId, messageId, action, vpsId) {
  const vps = await vpsManager.getVpsInstance(vpsId);
  if (!vps || vps.status !== 1) {
    return bot.sendMessage(chatId, '❌ Data tidak ditemukan.');
  }
  if (!isAdmin(chatId) && vps.user_id !== chatId) return bot.sendMessage(chatId, '❌ Akses ditolak.');

  let warn = '⚠️ Apakah kamu yakin?';
  if (action === 'delete') {
    warn = `⚠️ *Konfirmasi Hapus*\n\nServer akan *dihapus permanen* dan tidak bisa dikembalikan.`;
  } else if (action === 'rebuild_rdp') {
    warn = `⚠️ *Konfirmasi Rebuild RDP*\n\nJika RDP direbuild maka harus install ulang RDP-nya. *Semua data akan hilang.*`;
  } else if (action === 'reset_rdp') {
    warn = `⚠️ *Konfirmasi Reset Password RDP*\n\nReset password akan dilakukan dengan *install ulang RDP* (password berubah). *Semua data akan hilang.*`;
  } else if (action === 'rebuild_vps') {
    warn = `⚠️ *Konfirmasi Rebuild VPS*\n\nVPS akan dibuat ulang. *Semua data akan hilang.*`;
  } else if (action === 'reset_vps') {
    warn = `⚠️ *Konfirmasi Reset Password VPS*\n\nPassword root akan diganti dan dikirim ke kamu.`;
  }

  return safeMessageEditor.editMessage(bot, chatId, messageId, warn, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{
          text: '✅ Ya',
          callback_data: (action === 'rebuild_rdp' || action === 'reset_rdp')
            ? `srv_pickos:${action}:${vpsId}`
            : `srv_confirm:${action}:${vpsId}`
        }],
        [{ text: '❌ Batal', callback_data: `srv_view:${vpsId}` }]
      ]
    }
  });
}

// Show Windows version selection for RDP rebuild/reset.
async function showRdpWindowsPicker(bot, chatId, messageId, action, vpsId) {
  const osList = (require('../config/constants').DEDICATED_OS_VERSIONS || [])
    .filter(os => os && typeof os.version === 'string');

  // Keep the list reasonably short (standard/non-lite/non-uefi) similar to order flow.
  const filtered = osList.filter(os =>
    !os.version.includes('lite') &&
    !os.version.includes('uefi') &&
    os.version !== 'win_10atlas' &&
    // Keep rebuild list aligned with order list: do not offer Windows Server 2025
    os.version !== 'win_2025' &&
    os.name !== 'Windows Server 2025'
  );

  const list = filtered.length ? filtered : osList;

  const kb = list.slice(0, 25).map(os => ([{
    text: os.name,
    callback_data: `srv_confirmos:${action}:${vpsId}:${os.version}`
  }]));

  kb.push([{ text: '« Kembali', callback_data: `srv_view:${vpsId}` }]);

  const msg =
    `🪟 *Pilih Windows untuk ${action === 'reset_rdp' ? 'Reset Password' : 'Rebuild'} RDP*\n\n` +
    `⚠️ Setelah proses, Windows akan di-install ulang sesuai pilihan.\n` +
    `Semua data akan hilang.`;

  return safeMessageEditor.editMessage(bot, chatId, messageId, msg, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

function sshExec(ip, username, password, cmd, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';

    const onError = (err) => {
      try { conn.end(); } catch {}
      reject(err);
    };

    conn.on('ready', () => {
      conn.exec(cmd, { pty: true }, (err, stream) => {
        if (err) return onError(err);
        stream.on('close', (code) => {
          try { conn.end(); } catch {}
          if (code === 0 || code === undefined || code === null) return resolve({ stdout, stderr, code });
          return reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
        });
        stream.on('data', (d) => { stdout += d.toString(); });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });
      });
    }).on('error', onError);

    conn.connect({
      host: ip,
      port: 22,
      username,
      password,
      readyTimeout: timeoutMs
    });

    setTimeout(() => {
      try { conn.end(); } catch {}
    }, timeoutMs + 2000);
  });
}

async function expireInstanceIfNeeded(bot, chatId, vps) {
  const now = Math.floor(Date.now() / 1000);
  if (!vps.expires_at || Number(vps.expires_at) > now) return false;

  let token = null;
  try { token = await vpsManager.getDoApiTokenAny(vps.api_id); } catch (_) {}
  if (token && vps.droplet_id) {
    try { await deleteDroplet(token, vps.droplet_id); } catch (_) {}
  }
  if (vps.product_id) {
    try { await vpsManager.incrementProductSlotDuration(vps.product_id, Number(vps.duration_days) || 30); } catch (_) {}
  }
  await vpsManager.markVpsInstanceDeleted(vps.id);
  try { await backupManager.deleteBackup(vps.id); } catch (_) {}
  const exp = new Date(Number(vps.expires_at) * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  await bot.sendMessage(chatId, '⌛ Masa aktif VPS/RDP ini sudah expired dan data sudah dihapus otomatis.\n\nExpired: ' + exp + ' WIB');
  return true;
}

function durationPrice(vps) {
  const d = Number(vps?.duration_days || 30);
  if (d === 1) return vps?.price_daily != null ? Number(vps.price_daily) : Number(vps?.price || 0);
  if (d === 7) return vps?.price_weekly != null ? Number(vps.price_weekly) : Number(vps?.price || 0);
  return Number(vps?.price || 0);
}

function uniqueIds(ids) {
  const out = [];
  for (const id of ids) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

async function getOriginalApiCandidates(vps) {
  let product = null;
  try { product = await vpsManager.getProductAny(vps.product_id); } catch (_) {}
  // Prioritas utama: API yang saat ini tersimpan di instance.
  // Jika rebuild pernah pindah ke API lain karena API lama locked/suspend/hilang,
  // api_id instance sudah di-update ke API baru, jadi action berikutnya tetap memakai API baru itu.
  return uniqueIds([vps.api_id, product?.api_id, vps.origin_api_id]);
}

async function resolveTokenForInstance(vps, allowFallback = false, excludeApiId = null) {
  const originalCandidates = await getOriginalApiCandidates(vps);
  for (const apiId of originalCandidates) {
    if (excludeApiId && Number(apiId) === Number(excludeApiId)) continue;
    let token = null;
    try { token = await vpsManager.getDoApiTokenAny(apiId); } catch (_) {}
    if (token) {
      return { token, apiId, productId: vps.product_id, fromOriginal: true };
    }
  }

  if (!allowFallback) {
    return { token: null, apiId: originalCandidates[0] || vps.api_id, productId: vps.product_id, fromOriginal: true };
  }

  const fallback = await vpsManager.getFallbackProductForInstancePrefer(vps, excludeApiId || originalCandidates[0]);
  if (!fallback) return { token: null, apiId: null, productId: null, fromOriginal: false };
  let token = null;
  try { token = await vpsManager.getDoApiToken(fallback.api_id) || await vpsManager.getDoApiTokenAny(fallback.api_id); } catch (_) {}
  if (!token) return { token: null, apiId: fallback.api_id, productId: fallback.id, fromOriginal: false };
  return { token, apiId: fallback.api_id, productId: fallback.id, fromOriginal: false, fallback };
}

async function executeServiceAction(bot, chatId, messageId, action, vpsId, opts = {}) {
  const vps = await vpsManager.getVpsInstance(vpsId);
  if (!vps || vps.status !== 1) return bot.sendMessage(chatId, '❌ Data tidak ditemukan.');
  if (!isAdmin(chatId) && vps.user_id !== chatId) return bot.sendMessage(chatId, '❌ Akses ditolak.');

  if (await expireInstanceIfNeeded(bot, chatId, vps)) return;

  // Helper: create new droplet and swap
  const doRecreate = async ({ namePrefix, region, size, image, afterReady }) => {
    const newPass = genPass(12);
    const cloudInit = rootCloudInit(newPass);

    await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ Sedang memproses, mohon tunggu...', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
    });

    let tokenInfo = await resolveTokenForInstance(vps, true);
    if (!tokenInfo.token) throw new Error('API DigitalOcean pembuatan awal tidak ditemukan dan tidak ada API fallback yang tersedia.');

    async function createWith(info) {
      const token = info.token;
      const createSize = (require('../utils/doApi').isAwsToken(token) && String(image || '').startsWith('aws:') && String(vps.image || '').startsWith('rdp:')) ? normalizeAwsRdpSize(size) : size;
      const created = await createDroplet(token, `${namePrefix}-${crypto.randomBytes(4).toString('hex')}`, region, createSize, image, cloudInit);
      if (!created || !created.dropletId) return { ok: false, error: created?.error || 'Gagal membuat droplet baru.', info };
      const ip = await waitPublicIp(token, created.dropletId, 30, 5000, region);
      if (!ip) {
        try { await deleteDroplet(token, created.dropletId, region); } catch (_) {}
        return { ok: false, error: 'IP droplet baru belum tersedia.', info };
      }
      // Linode tidak boleh dipaksa Direct Disk sebelum installer RDP berjalan,
      // karena tahap awal butuh GRUB untuk boot Alpine installer. Direct Disk diset tertunda saat instalasi dimulai.
      return { ok: true, ip, dropletId: created.dropletId, info };
    }

    let made = await createWith(tokenInfo);
    // Jika API asal order gagal/error/hilang limit, baru fallback ke API lain yang stoknya cocok.
    if (!made.ok && tokenInfo.fromOriginal) {
      const fallbackInfo = await resolveTokenForInstance(vps, true, tokenInfo.apiId);
      if (fallbackInfo.token && Number(fallbackInfo.apiId) !== Number(tokenInfo.apiId)) {
        const fbMade = await createWith(fallbackInfo);
        if (fbMade.ok) made = fbMade;
      }
    }
    if (!made.ok) throw new Error(made.error || 'Gagal membuat droplet baru.');

    tokenInfo = made.info;
    const dropletId = made.dropletId;
    const ip = made.ip;

    if (!tokenInfo.fromOriginal && tokenInfo.productId) {
      try {
        await vpsManager.decrementProductSlotDuration(tokenInfo.productId, Number(vps.duration_days) || 30);
        if (vps.product_id && Number(vps.product_id) !== Number(tokenInfo.productId)) {
          await vpsManager.incrementProductSlotDuration(vps.product_id, Number(vps.duration_days) || 30);
        }
        await vpsManager.updateVpsInstanceApiProduct(vpsId, tokenInfo.apiId, tokenInfo.productId);
      } catch (e) {
        try { await deleteDroplet(tokenInfo.token, dropletId); } catch (_) {}
        throw e;
      }
    }

    // Update DB to new droplet (store password for user). Expired date tidak diubah: tetap ikut order awal.
    await vpsManager.updateVpsInstanceDroplet(vpsId, dropletId, ip, region, image, newPass);

    // Delete old droplet using API asal pembuatan, bukan API acak.
    if (vps.droplet_id) {
      const oldInfo = await resolveTokenForInstance(vps, false);
      if (oldInfo.token) { try { await deleteDroplet(oldInfo.token, vps.droplet_id); } catch (_) {} }
    }

    if (afterReady) {
      await afterReady({ ip, rootPass: newPass, dropletId });
    }

    return { ip, rootPass: newPass, dropletId, apiId: tokenInfo.apiId, productId: tokenInfo.productId, fromOriginalApi: tokenInfo.fromOriginal, provider: require('../utils/doApi').isAwsToken(tokenInfo.token) ? 'aws' : (isLinodeToken(tokenInfo.token) ? 'linode' : 'digitalocean') };
  };

  if (action === 'delete') {
    await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ Menghapus server...', {
      reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] }
    });

    if (vps.droplet_id) {
      const delInfo = await resolveTokenForInstance(vps, false);
      if (delInfo.token) { try { await deleteDroplet(delInfo.token, vps.droplet_id); } catch (_) {} }
    }
    // Return stock when user/admin deletes an instance before expiry.
    if (vps.product_id) {
      try {
        await vpsManager.incrementProductSlotDuration(vps.product_id, Number(vps.duration_days) || 30);
      } catch (_) {}
    }
    await vpsManager.markVpsInstanceDeleted(vpsId);
    try { await backupManager.deleteBackup(vpsId); } catch (_) {}

    await bot.sendMessage(chatId, '🔥 Server berhasil dihapus.\n\nKetik /start untuk kembali ke menu.');
    return;
  }

  if (action === 'reset_vps') {
    // Try reset via SSH using stored password
    const newPass = genPass(14);
    try {
      await sshExec(vps.ip, 'root', vps.root_password, `echo "root:${newPass}" | chpasswd`);
      await vpsManager.updateVpsInstancePassword(vpsId, newPass);

      await bot.sendMessage(chatId,
        `✅ *Password VPS berhasil direset!*\n\n` +
        `🌐 IP: \`${vps.ip}\`\n` +
        `👤 Username: \`root\`\n` +
        `🔑 Password Baru: \`${newPass}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await bot.sendMessage(chatId,
        `❌ Gagal reset password via SSH.\n\n` +
        `Kemungkinan password sudah berubah atau SSH belum siap.\n` +
        `Solusi: gunakan *Rebuild VPS* untuk password baru.`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  if (action === 'rebuild_vps') {
    const imageSlug = (vps.image && !String(vps.image).startsWith('rdp:')) ? vps.image : 'ubuntu-22-04-x64';
    const size = vps.size_slug || 's-1vcpu-1gb';
    const region = vps.region || 'sgp1';

    const rebuilt = await doRecreate({
      namePrefix: 'vps',
      region,
      size,
      image: imageSlug
    });
    const ip = rebuilt.ip;
    const rootPass = rebuilt.rootPass;

    await bot.sendMessage(chatId,
      '✅ *VPS berhasil direbuild!*\n\n' +
      '🌐 IP: `' + ip + '`\n' +
      '👤 Username: `root`\n' +
      '🔑 Password: `' + rootPass + '`\n\n' +
      'Silakan login kembali menggunakan detail baru ini.',
      { parse_mode: 'Markdown' }
    );

    await notifyOrderSuccess(bot, {
      event: 'REBUILD',
      type: 'VPS',
      ip,
      spec: (String(Number(vps.ram || 0) || '') + 'GB / ' + String(Number(vps.core || 0) || '') + ' CORE (' + String(vps.size_slug || '') + ')').replace(/^GB \/  CORE /, '').trim(),
      apiId: rebuilt.apiId || vps.api_id,
      durationDays: Number(vps.duration_days) || 30,
      price: durationPrice(vps),
      region,
      buyerId: vps.user_id
    });
    return;
  }
  // RDP actions: reset/rebuild both reinstall
  if (action === 'rebuild_rdp' || action === 'reset_rdp') {
    // osVersion should be a version code (e.g. win_22) compatible with tele.sh
    const chosen = opts?.osVersion;
    const stored = String(vps.image || '').startsWith('rdp:') ? vps.image.replace('rdp:', '') : null;
    const osVersion = String(chosen || stored || 'win_2016');
    const osName = (() => {
      try {
        const list = require('../config/constants').DEDICATED_OS_VERSIONS || [];
        const found = list.find(x => x && x.version === osVersion);
        return found?.name || osVersion;
      } catch {
        return osVersion;
      }
    })();
    const region = vps.region || 'sgp1';
    const size = vps.size_slug || 's-2vcpu-2gb';

    const { installDedicatedRDP } = require('../utils/dedicatedRdpInstaller');
    const RDPMonitor = require('../utils/rdpMonitor');

    const rebuilt = await doRecreate({
      namePrefix: 'rdp',
      region,
      size,
      image: 'ubuntu-22-04-x64'
    });
    const { ip, rootPass } = rebuilt;

    // Store chosen Windows version in DB (display purposes & future rebuild default)
    await vpsManager.updateVpsInstanceImage(vpsId, `rdp:${osVersion}`);

    // Custom password if user picked it in the wizard, else auto-generate.
    // opts.customPassword is validated at capture time; guard again here.
    const rdpPass = (opts?.customPassword && validateWindowsPassword(opts.customPassword).ok)
      ? opts.customPassword
      : genPass(12);

    // ─── BUGFIX (SSH wait): mirror create-RDP flow ─────────────────────
    // Previously we skipped this wait and kicked off installDedicatedRDP()
    // immediately after doRecreate() returned. The installer's own SSH
    // retry loop worked, but the Linode Direct Disk schedule (5/7/9 min)
    // was measured from doRecreate return — which is 2-5 min BEFORE the
    // VPS is actually reachable. Result: direct-disk sometimes fired
    // before Alpine finished pulling the Windows image, leaving the
    // machine stuck at a `grub>` prompt on reboot.
    //
    // By waiting for SSH first, the 5/7/9 minute schedule is anchored
    // to "SSH ready" — same relative timing as create-RDP.
    await bot.sendMessage(chatId, '⏳ Menunggu VPS boot dan port SSH siap...');
    const sshReady = await waitForPort(ip, 22, 12 * 60 * 1000, 15000);
    if (!sshReady) {
      await bot.sendMessage(chatId,
        '❌ VPS tidak menyala dalam 12 menit setelah rebuild.\n\n' +
        'Coba rebuild lagi. Kalau gagal berulang, cek status VPS di panel provider (mungkin butuh manual power-on).'
      );
      return;
    }

    // Start install (do not throw on reboot)
    await bot.sendMessage(chatId,
      `🚀 Memulai instalasi Windows RDP otomatis...\n\n` +
      `🌐 IP: \`${ip}\`\n` +
      `🪟 Windows: *${osName}*\n` +
      `🔒 Port RDP: *4443*\n\n` +
      `⏳ Estimasi maksimal 15 menit.\n` +
      `🔔 Kamu akan dapat notifikasi saat RDP siap.`,
      { parse_mode: 'Markdown' }
    );

    const installPromise = installDedicatedRDP(ip, 'root', rootPass, {
      osVersion,
      password: rdpPass,
      provider: rebuilt.provider || 'digitalocean'
    }, (l) => console.log(`[${ip}] ${l}`));

    // ─── BUGFIX (Linode Direct Disk): don't fall back to the OLD droplet id ─
    // Previous code: linodeSetDirectDisk(token, rebuilt.dropletId || vps.droplet_id)
    // If doRecreate returned without a new dropletId (rare, but possible on
    // API races), the fallback pointed to the just-destroyed droplet — the
    // Linode API returns 404 and direct-disk NEVER gets set, so the reboot
    // boots to grub. We now require the fresh dropletId and log a clear
    // warning if it's missing, instead of poisoning the config silently.
    if (rebuilt.apiId && rebuilt.dropletId) {
      const scheduleLinodeDirectDisk = (minutes) => setTimeout(async () => {
        try {
          const actionToken = await vpsManager.getDoApiTokenAny(rebuilt.apiId);
          if (!isLinodeToken(actionToken)) return;
          const dd = await linodeSetDirectDisk(actionToken, rebuilt.dropletId);
          if (!dd.ok) console.warn(`[${ip}] Gagal set Linode Direct Disk (${minutes}m):`, dd.error);
          else console.log(`[${ip}] Linode Direct Disk diset otomatis (${minutes}m) untuk boot Windows.`);
        } catch (e) {
          console.warn(`[${ip}] Gagal set Linode Direct Disk (${minutes}m):`, e.message || e);
        }
      }, minutes * 60 * 1000);
      [5, 7, 9].forEach(scheduleLinodeDirectDisk);
    } else if (rebuilt.apiId && !rebuilt.dropletId) {
      console.warn(`[${ip}] Skip Linode Direct Disk schedule: rebuilt.dropletId missing (would have used old id ${vps.droplet_id}).`);
    }

    installPromise.catch(async (err) => {
      console.error('Order RDP installer error:', err && err.message ? err.message : err);
      try {
        await bot.sendMessage(chatId, '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.');
      } catch (_) {}
    });
    // BUGFIX (save password BEFORE monitor): previously we called
    // updateVpsInstancePassword AFTER monitor success. On timeout the
    // user's newly-generated Windows password was never persisted, so
    // even if the RDP eventually came up the user had no way to know
    // their credentials. Save the password up front so it survives any
    // outcome — the DB is now the source of truth for the "🔑 Lihat
    // Password" feature in VPS&RDP Saya.
    await vpsManager.updateVpsInstancePassword(vpsId, rdpPass);

    const hostname = `rdp-${chatId}-${crypto.randomBytes(3).toString('hex')}`;

    const monitor = new RDPMonitor(ip, 'root', rootPass, rdpPass, 4443);

    // Wait for RDP port to become ready (monitor checks every 30s).
    // Timeout extended from 15 → 25 min: Linode non-SGP + AWS Windows
    // installs frequently finish in the 15-22 min window.
    const mon = await monitor.waitForRDPReady(RDP_MONITOR_TIMEOUT_MS, (msg) => console.log(`[${ip}] ${msg}`));
    if (!mon || mon.rdpReady !== true) {
      // BUGFIX (timeout card with password): hand the user their creds
      // and a "try connecting first" nudge instead of a dead-end "gagal
      // rebuild" that hides the working credentials.
      await bot.sendMessage(chatId,
        buildTimeoutCardMarkdown({
          ip, port: 4443, hostname, osName, region, password: rdpPass,
          elapsedMin: mon?.totalTime || Math.round(RDP_MONITOR_TIMEOUT_MS / 60000)
        }),
        {
          parse_mode: 'Markdown',
          reply_markup: buildTimeoutCardKeyboard({ ip, port: 4443, password: rdpPass })
        }
      );
      return;
    }
    const detail =
`🎉 Detail Akun RDP Windows - SIAP PAKAI\n\n` +
`🏷️ Hostname: ${hostname}\n` +
	`📍 Region: ${region}\n` +
	`🪟 Windows: ${osName}\n` +
`🌐 Server: ${ip}:4443\n` +
`👤 Username: administrator\n` +
`🔑 Password: ${rdpPass}\n\n` +
`✅ RDP SUDAH SIAP digunakan sekarang!`;

    await bot.sendMessage(chatId, detail, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 Copy Server', callback_data: `copy_server_${ip}:4443` }],
          [{ text: '📋 Copy Username', callback_data: 'copy_username_administrator' }],
          [{ text: '📋 Copy Password', callback_data: `copy_pass_${rdpPass}` }],
          [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
        ]
      }
    });

	    // Notify channel/group about rebuild as well (if configured)
	    await notifyOrderSuccess(bot, {
	      event: action === 'reset_rdp' ? 'RESET' : 'REBUILD',
	      type: 'RDP',
	      ip: `${ip}:4443`,
	      spec: `${Number(vps.ram || 0) || ''}GB / ${Number(vps.core || 0) || ''} CORE (${vps.size_slug || ''})`.replace(/^GB \/  CORE /, '').trim(),
	      apiId: rebuilt.apiId || vps.api_id,
	      durationDays: Number(vps.duration_days) || 30,
	      price: durationPrice(vps),
	      region,
	      windows: osName,
      buyerId: vps.user_id
	    });

	    // Channel #2 (testimoni) - minimal, optional
	    await notifyOrderTestimonial(bot, { productName: 'RDP' });

    return;
  }

  throw new Error('Aksi tidak dikenal.');
}


async function deleteMyVps(bot, chatId, messageId, vpsId) {
  // backward compatibility
  return executeServiceAction(bot, chatId, messageId, 'delete', vpsId);
}


async function askRdpPasswordMode(bot, chatId, messageId, action, vpsId, osVersion) {
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🔐 *Password RDP*\n\n' +
    'Pilih cara set password:\n\n' +
    '• *Auto* — bot generate password random (recommended, aman).\n' +
    '• *Custom* — kamu ketik password sendiri (min 8 char, huruf+angka).',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎲 Auto (Recommended)', callback_data: `srv_pass_auto:${action}:${vpsId}:${osVersion}` }],
          [{ text: '🔐 Custom Password', callback_data: `srv_pass_custom:${action}:${vpsId}:${osVersion}` }],
          [{ text: '« Kembali', callback_data: `srv_pickos:${action}:${vpsId}` }]
        ]
      }
    }
  );
}

async function startCustomPasswordInput(bot, chatId, messageId, action, vpsId, osVersion, sessionManager) {
  sessionManager.setUserSession(chatId, {
    installType: 'rdp_custom_password',
    step: 'waiting_password',
    action,
    vpsId,
    osVersion,
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
    'Contoh valid: `Renter2024`, `Sewa123abc`',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `srv_pickos:${action}:${vpsId}` }]] }
    }
  );
}

async function processCustomPasswordInput(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getUserSession(chatId);
  if (!session) return false;
  if (session.installType !== 'rdp_custom_password') return false;
  if (session.step !== 'waiting_password') return false;

  const rawPassword = String(msg.text || '').trim();
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}

  const check = validateWindowsPassword(rawPassword);
  if (!check.ok) {
    await bot.sendMessage(chatId,
      `❌ ${check.error}\n\nKirim ulang password, atau tekan Batal.`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `srv_pickos:${session.action}:${session.vpsId}` }]] } }
    );
    return true;
  }

  const { action, vpsId, osVersion, messageId } = session;
  sessionManager.clearUserSession(chatId);

  // Kick off the rebuild with the user-supplied password.
  await executeServiceAction(bot, chatId, messageId, action, vpsId, { osVersion, customPassword: rawPassword });
  return true;
}

module.exports = {
  showProducts,
  pickProductGroup,
  pickProviderByDuration,
  pickProductByProvider,
  pickProduct,
  pickRegion,
  createVps,
  showMyVps,
  showRdpPassword,
  askRdpPasswordMode,
  startCustomPasswordInput,
  processCustomPasswordInput,
  showMyServices,
  viewMyService,
  confirmServiceAction,
  showRdpWindowsPicker,
  executeServiceAction,
  deleteMyVps
};
