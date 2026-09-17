const db = require('../config/database');
const adminSettings = require('../utils/adminSettings');
const { createPayment, checkPaymentStatus } = require('../utils/payment');
const ShopPaymentTracker = require('../utils/shopPaymentTracker');
const { handleShopPaymentStatus, cancelShopPaymentMonitoring, isShopPaymentMonitoring } = require('../utils/shopPaymentStatus');
const QRCode = require('qrcode');
const { isAdmin } = require('../utils/userManager');
const menuBanner = require('../utils/menuBanner');

function safeMd(text) {
  return String(text || '').replace(/[_*`]/g, '\\$&');
}

function formatRupiah(n) {
  try {
    return `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
  } catch {
    return `Rp ${n}`;
  }
}

async function countStock(code) {
  // Stok tersedia = belum terjual dan tidak sedang di-reserve invoice aktif.
  const row = await db.get(
    `SELECT COUNT(*) AS c
     FROM shop_stock_items
     WHERE product_code = ?
       AND is_sold = 0
       AND (reserved_by_order_id IS NULL OR reserved_until IS NULL OR reserved_until <= ?)`,
    [code, Date.now()]
  );
  return Number(row?.c || 0);
}

async function cleanupExpiredReservations() {
  await db.run(
    `UPDATE shop_stock_items
     SET reserved_by_order_id = NULL, reserved_until = NULL
     WHERE is_sold = 0
       AND reserved_by_order_id IS NOT NULL
       AND reserved_until IS NOT NULL
       AND reserved_until <= ?`,
    [Date.now()]
  );
}

async function releaseOrderReservation(orderId) {
  await db.run(
    `UPDATE shop_stock_items
     SET reserved_by_order_id = NULL, reserved_until = NULL
     WHERE is_sold = 0 AND reserved_by_order_id = ?`,
    [orderId]
  );
}

async function reserveStockForOrder(productCode, qty, orderId, reservedUntil) {
  await cleanupExpiredReservations();
  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const items = await db.all(
      `SELECT id
       FROM shop_stock_items
       WHERE product_code = ?
         AND is_sold = 0
         AND (reserved_by_order_id IS NULL OR reserved_until IS NULL OR reserved_until <= ?)
       ORDER BY id ASC
       LIMIT ?`,
      [productCode, Date.now(), qty]
    );

    if (!items || items.length < qty) {
      await db.exec('ROLLBACK');
      return false;
    }

    const ids = items.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');
    await db.run(
      `UPDATE shop_stock_items
       SET reserved_by_order_id = ?, reserved_until = ?
       WHERE id IN (${placeholders})`,
      [orderId, reservedUntil, ...ids]
    );
    await db.exec('COMMIT');
    return true;
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

async function showShopMenu(bot, chatId, messageId) {
  const admin = isAdmin(chatId);
  const extraRow = admin ? [[{ text: '🛠️ Admin Shop', callback_data: 'shop_admin_menu' }]] : [];
  await menuBanner.showMenu(
    bot,
    chatId,
    messageId,
    '🛒 *Auto Order / Shop*\n\n' +
      'Pilih menu di bawah:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📦 Lihat Produk', callback_data: 'shop_list' }],
          ...extraRow,
          [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
        ]
      }
    }
  );
}

async function listProducts(bot, chatId, messageId) {
  const products = await db.all('SELECT * FROM shop_products ORDER BY name ASC');
  if (!products || products.length === 0) {
    await bot.editMessageText(
      '📦 *Daftar Produk*\n\nBelum ada produk.\n\n' +
        'Admin bisa mengisi tabel `shop_products` dan `shop_stock_items` di SQLite (rdp.db).',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_menu' }]]
        }
      }
    );
    return;
  }

  const rows = [];
  for (const p of products) {
    const stok = await countStock(p.code);
    rows.push([{ text: `${p.name} (Stok: ${stok})`, callback_data: `shop_prod_${p.code}` }]);
  }
  rows.push([{ text: '« Kembali', callback_data: 'shop_menu' }]);

  await bot.editMessageText('📦 *Daftar Produk*\n\nPilih produk:', {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows }
  });
}

async function showProduct(bot, chatId, messageId, code) {
  const p = await db.get('SELECT * FROM shop_products WHERE code = ?', [code]);
  if (!p) {
    await bot.editMessageText('❌ Produk tidak ditemukan.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_list' }]] }
    });
    return;
  }
  const stok = await countStock(code);
  const desc = p.description ? `\n\n${safeMd(p.description)}` : '';

  const text = `🛍️ *${safeMd(p.name)}*\n` +
    `💰 Harga: *${formatRupiah(p.price)}*\n` +
    `📦 Stok: *${stok}*${desc}`;

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🧾 Beli', callback_data: `shop_buy_${p.code}` }],
        [{ text: '« Kembali', callback_data: 'shop_list' }]
      ]
    }
  });
}

async function startBuy(bot, chatId, messageId, code, sessionManager) {
  const p = await db.get('SELECT * FROM shop_products WHERE code = ?', [code]);
  if (!p) {
    await bot.editMessageText('❌ Produk tidak ditemukan.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_list' }]] }
    });
    return;
  }
  const stok = await countStock(code);
  if (stok <= 0) {
    await bot.editMessageText('❌ Stok habis.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: `shop_prod_${code}` }]] }
    });
    return;
  }

  await bot.editMessageText(
    `🧾 *Beli ${safeMd(p.name)}*\n\n` +
      `Masukkan jumlah (qty).\n` +
      `Stok tersedia: *${stok}*`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '« Batal', callback_data: `shop_prod_${code}` }]]
      }
    }
  );

  sessionManager.setShopSession(chatId, {
    step: 'waiting_qty',
    messageId,
    productCode: code
  });
}

async function handleQtyInput(bot, msg, shopSession, sessionManager) {
  const chatId = msg.chat.id;
  const qty = parseInt(String(msg.text || '').replace(/[^0-9]/g, ''), 10);

  try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

  if (!qty || qty <= 0) {
    await bot.sendMessage(chatId, '❌ Qty tidak valid. Masukkan angka, contoh: 1');
    return;
  }

  const code = shopSession.productCode;
  const p = await db.get('SELECT * FROM shop_products WHERE code = ?', [code]);
  if (!p) {
    sessionManager.clearShopSession(chatId);
    await bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');
    return;
  }

  await cleanupExpiredReservations();
  const stok = await countStock(code);
  if (qty > stok) {
    await bot.sendMessage(chatId, `❌ Stok tidak cukup. Stok tersedia: ${stok}`);
    return;
  }

  const adminFee = await adminSettings.getNumber('shop_admin_fee_flat', 0);
  const amount = (Number(p.price) * qty) + Number(adminFee || 0);

  // Buat order lokal dulu, lalu reserve stok SEBELUM QRIS dibuat.
  // Ini mencegah 2 pembeli membayar stok yang sama ketika stok tinggal 1.
  const createdAt = new Date().toISOString();
  const provisionalExpiryTime = Date.now() + 30 * 60 * 1000;
  const provisionalExpireAt = new Date(provisionalExpiryTime).toISOString();
  const orderRes = await db.run(
    `INSERT INTO shop_orders (user_id, chat_id, product_code, qty, amount, admin_fee, status, created_at, expire_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chatId,
      chatId,
      code,
      qty,
      amount,
      Number(adminFee || 0),
      'creating_payment',
      createdAt,
      provisionalExpireAt
    ]
  );
  const orderId = orderRes.id;

  const reserved = await reserveStockForOrder(code, qty, orderId, provisionalExpiryTime);
  if (!reserved) {
    await db.run('UPDATE shop_orders SET status = ? WHERE id = ?', ['failed_out_of_stock', orderId]);
    await bot.sendMessage(chatId, `❌ Stok baru saja habis/direserve pembeli lain. Stok tersedia: ${await countStock(code)}`);
    return;
  }

  // Create payment
  await bot.editMessageText('Membuat tagihan pembayaran QRIS...', {
    chat_id: chatId,
    message_id: shopSession.messageId,
    parse_mode: 'Markdown'
  });

  const uniqueCode = `ORD${Date.now()}${chatId}`;
  const payment = await createPayment(process.env.DOMPETX_API_KEY, uniqueCode, amount);
  if (!payment.success) {
    await releaseOrderReservation(orderId);
    await db.run('UPDATE shop_orders SET status = ? WHERE id = ?', ['failed', orderId]);
    sessionManager.clearShopSession(chatId);
    await bot.editMessageText(
      `❌ Gagal membuat pembayaran QRIS. Stok sudah dilepas kembali.

Error: ${safeMd(payment.error || 'unknown')}`,
      {
        chat_id: chatId,
        message_id: shopSession.messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: `shop_prod_${code}` }]] }
      }
    );
    return;
  }

  const expiryTime = payment.data.expired_at ? new Date(payment.data.expired_at).getTime() : provisionalExpiryTime;
  const expireAt = new Date(expiryTime).toISOString();

  await db.run(
    `UPDATE shop_orders
     SET status = ?, expire_at = ?, payment_ref = ?, trx_id = ?, qris_string = ?, qris_image = ?
     WHERE id = ?`,
    [
      'pending_payment',
      expireAt,
      payment.data.reff_id,
      payment.data.id,
      payment.data.qr_string,
      payment.data.qr_image,
      orderId
    ]
  );
  await db.run(
    'UPDATE shop_stock_items SET reserved_until = ? WHERE reserved_by_order_id = ? AND is_sold = 0',
    [expiryTime, orderId]
  );

  await ShopPaymentTracker.addPendingPayment(chatId, payment.data.id, uniqueCode, orderId, amount, expiryTime);

  // Send QR
  const caption = `🧾 *Invoice Order*\n\n` +
    `📦 Produk: *${safeMd(p.name)}*\n` +
    `🔢 Qty: *${qty}*\n` +
    `💰 Total: *${formatRupiah(amount)} ditambah fee payment gateway*\n` +
    `⏳ Expired: *${new Date(expiryTime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}*\n\n` +
    `Silakan scan QRIS untuk bayar.`;

  let qrBuffer = null;
  if (payment.data.qr_string) {
    try {
      qrBuffer = await QRCode.toBuffer(payment.data.qr_string, { type: 'png', width: 400, margin: 2 });
    } catch {}
  }

  // delete previous menu message to avoid editing photo/text mismatch
  try { await bot.deleteMessage(chatId, shopSession.messageId); } catch {}

  const payUrl = payment.data.payment_url || payment.data.qr_image || null;
  const shopRows = [];
  if (payUrl) shopRows.push([{ text: '💳 Bayar Sekarang (QRIS)', url: payUrl }]);
  shopRows.push([{ text: '🔄 Refresh Status', callback_data: `shop_refresh_${orderId}` }]);
  shopRows.push([{ text: '❌ Batalkan', callback_data: `shop_cancel_${orderId}` }]);
  const replyMarkup = { inline_keyboard: shopRows };

  let sent;
  if (qrBuffer) {
    sent = await bot.sendPhoto(chatId, qrBuffer, { caption, parse_mode: 'Markdown', reply_markup: replyMarkup });
  } else {
    sent = await bot.sendMessage(chatId, caption + (payUrl ? '\n\n👉 Tekan *Bayar Sekarang (QRIS)* untuk membuka halaman pembayaran.' : ''), {
      parse_mode: 'Markdown',
      reply_markup: replyMarkup
    });
  }

  // save qr_msg_id
  await db.run('UPDATE shop_orders SET qr_msg_id = ? WHERE id = ?', [sent.message_id, orderId]);

  sessionManager.clearShopSession(chatId);

  // auto monitor
  await handleShopPaymentStatus(bot, chatId, sent.message_id, payment.data.id, orderId, amount);
}

async function refreshShopPayment(bot, chatId, messageId, orderId) {
  const order = await db.get('SELECT * FROM shop_orders WHERE id = ?', [orderId]);
  if (!order) {
    await bot.editMessageText('❌ Order tidak ditemukan.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_list' }]] }
    });
    return;
  }
  const pending = await ShopPaymentTracker.getPendingByOrder(orderId);
  if (!pending) {
    await bot.sendMessage(chatId, 'ℹ️ Tidak ada tagihan shop yang tertunda untuk order ini.');
    return;
  }

  // manual check
  const paymentStatus = await checkPaymentStatus(process.env.DOMPETX_API_KEY, pending.transaction_id);
  const status = (paymentStatus?.data?.status || '').toString().toLowerCase();
  const caption = `🔎 Status pembayaran: *${safeMd(status || 'unknown')}*\n` +
    `💰 Total: *${formatRupiah(pending.amount)}*`;
  await bot.sendMessage(chatId, caption, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]] }
  });

  // keep monitoring a bit (avoid duplicate monitor if auto-monitor already running)
  if (!isShopPaymentMonitoring(pending.transaction_id)) {
    await handleShopPaymentStatus(bot, chatId, messageId, pending.transaction_id, orderId, pending.amount);
  }
}

async function cancelShopPayment(bot, chatId, messageId, orderId) {
  const pending = await ShopPaymentTracker.getPendingByOrder(orderId);
  if (pending) {
    cancelShopPaymentMonitoring(pending.transaction_id);
    await ShopPaymentTracker.removePendingPayment(pending.transaction_id);
  }
  await releaseOrderReservation(orderId);
  await db.run('UPDATE shop_orders SET status = ? WHERE id = ?', ['cancelled', orderId]);

  try { await bot.deleteMessage(chatId, messageId); } catch {}

  await bot.sendMessage(chatId, '✅ Tagihan dibatalkan.', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛒 Kembali ke Produk', callback_data: 'shop_list' }],
        [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
      ]
    }
  });
}


// ===================== Admin Shop (Kelola Produk & Stok) =====================

function requireAdmin(bot, chatId) {
  if (!isAdmin(chatId)) {
    bot.sendMessage(chatId, '❌ Khusus admin.').catch(() => {});
    return false;
  }
  return true;
}

function parseKeyValueBlock(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;
    // KEY: value
    const m = line.match(/^([A-Z0-9 _-]{2,})\s*:\s*(.*)$/i);
    if (m) {
      const k = m[1].trim().toLowerCase();
      const v = (m[2] || '').trim();
      out[k] = v;
    }
  }
  return out;
}

async function showShopAdminMenu(bot, chatId, messageId) {
  if (!requireAdmin(bot, chatId)) return;

  await menuBanner.showMenu(
    bot,
    chatId,
    messageId,
    '🛠️ *Admin Shop*\n\n' +
      'Kelola produk & stok Auto Order:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Tambah Produk', callback_data: 'shop_admin_add_product' }],
          [{ text: '🗂️ List Produk', callback_data: 'shop_admin_list_products' }],
          [{ text: '💲 Ubah Harga Produk', callback_data: 'shop_admin_pick_price' }],
          [{ text: '📝 Set Keterangan', callback_data: 'shop_admin_pick_desc' }],
          [{ text: '🗑️ Hapus Produk', callback_data: 'shop_admin_del_product' }],
          [{ text: '➕ Tambah Stok', callback_data: 'shop_admin_pick_add_stock' }],
          [{ text: '🗑️ Hapus Stok', callback_data: 'shop_admin_pick_del_stock' }],
          [{ text: '⚙️ Set Admin Fee Shop', callback_data: 'shop_admin_set_fee' }],
          [{ text: '« Kembali', callback_data: 'shop_menu' }]
        ]
      }
    }
  );
}

async function adminListProducts(bot, chatId, messageId) {
  if (!requireAdmin(bot, chatId)) return;

  const products = await db.all('SELECT * FROM shop_products ORDER BY name ASC');
  if (!products || products.length === 0) {
    await bot.editMessageText('📦 *List Produk*\n\nBelum ada produk.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_admin_menu' }]] }
    });
    return;
  }

  let text = '📦 *List Produk*\n\n';
  for (const p of products) {
    const stok = await countStock(p.code);
    text += `• *${safeMd(p.name)}* \`(${safeMd(p.code)})\`\n  Harga: *${formatRupiah(p.price)}* | Stok: *${stok}*\n`;
    if (p.description) {
      const d = safeMd(String(p.description)).slice(0, 120);
      text += `  Ket: ${d}${String(p.description).length > 120 ? '…' : ''}\n`;
    }
    text += '\n';
  }

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_admin_menu' }]] }
  });
}

async function adminStartAddProduct(bot, chatId, messageId, sessionManager) {
  if (!requireAdmin(bot, chatId)) return;

  await bot.editMessageText(
    '➕ *Tambah Produk*\n\n' +
      'Kirim data produk (1 pesan) dengan format:\n\n' +
      '`CODE: do10drop`\n' +
      '`NAMA: Netflix 1 Bulan`\n' +
      '`HARGA: 15000`\n' +
      '`KET: Garansi 1x24 jam`\n\n' +
      '_KET opsional._',
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Batal', callback_data: 'shop_admin_menu' }]] }
    }
  );

  sessionManager.setAdminSession(chatId, { action: 'shop_add_product', messageId });
}

async function processAddProduct(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  if (!requireAdmin(bot, chatId)) return;

  const kv = parseKeyValueBlock(msg.text);
  const code = (kv.code || kv.kode || '').trim();
  const name = (kv.nama || kv.name || '').trim();
  const price = parseInt(String(kv.harga || kv.price || '').replace(/[^0-9]/g, ''), 10);
  const desc = (kv.ket || kv.keterangan || kv.desc || kv.description || '').trim();

  if (!code || !name || !price || price <= 0) {
    await bot.sendMessage(chatId,
      '❌ Data tidak lengkap.\n\nWajib: CODE, NAMA, HARGA.\nContoh:\n`CODE: NETFLIX1`\n`NAMA: Netflix 1 Bulan`\n`HARGA: 15000`',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  await db.run(
    'INSERT INTO shop_products(code, name, price, description) VALUES(?,?,?,?) ' +
      'ON CONFLICT(code) DO UPDATE SET name=excluded.name, price=excluded.price, description=excluded.description',
    [code, name, price, desc]
  );

  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId, `✅ Produk disimpan:\n• ${name} (${code})\n• Harga: ${formatRupiah(price)}`, {
    reply_markup: { inline_keyboard: [[{ text: '🛠️ Admin Shop', callback_data: 'shop_admin_menu' }]] }
  });
}

async function adminPromptDeleteProduct(bot, chatId, messageId) {
  if (!requireAdmin(bot, chatId)) return;

  const products = await db.all('SELECT code, name FROM shop_products ORDER BY name ASC');
  if (!products || products.length === 0) {
    await bot.editMessageText('🗑️ *Hapus Produk*\n\nBelum ada produk.', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_admin_menu' }]] }
    });
    return;
  }

  const rows = products.map(p => ([{ text: `Del ${p.name} (${p.code})`, callback_data: `shop_admin_delprod_${p.code}` }]));
  rows.push([{ text: '« Kembali', callback_data: 'shop_admin_menu' }]);

  await bot.editMessageText('🗑️ *Pilih produk yang akan dihapus:*', {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows }
  });
}

async function adminConfirmDeleteProduct(bot, chatId, messageId, code) {
  if (!requireAdmin(bot, chatId)) return;

  const p = await db.get('SELECT code, name FROM shop_products WHERE code=?', [code]);
  if (!p) {
    await bot.editMessageText('❌ Produk tidak ditemukan.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_admin_del_product' }]] }
    });
    return;
  }

  await bot.editMessageText(
    `⚠️ *Konfirmasi Hapus Produk*\n\n` +
      `Produk: *${safeMd(p.name)}* \`(${safeMd(p.code)})\`\n\n` +
      `_Semua stok yang terkait juga akan ikut terhapus._`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Ya, Hapus', callback_data: `shop_admin_delprod_yes_${p.code}` }],
          [{ text: '❌ Batal', callback_data: 'shop_admin_del_product' }]
        ]
      }
    }
  );
}

async function adminDoDeleteProduct(bot, chatId, messageId, code) {
  if (!requireAdmin(bot, chatId)) return;

  try {
    const orderRows = await db.all('SELECT id FROM shop_orders WHERE product_code=?', [code]);
    const orderIds = orderRows.map(r => r.id).filter(Boolean);

    for (const orderId of orderIds) {
      await db.run('DELETE FROM shop_pending_payments WHERE order_id=?', [orderId]);
    }

    await db.run('DELETE FROM shop_orders WHERE product_code=?', [code]);
    await db.run('DELETE FROM shop_stock_items WHERE product_code=?', [code]);
    const res = await db.run('DELETE FROM shop_products WHERE code=?', [code]);

    await bot.editMessageText(
      res?.changes ? `✅ Produk \`${safeMd(code)}\` dihapus.` : '❌ Produk tidak ditemukan.',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🛠️ Admin Shop', callback_data: 'shop_admin_menu' }]] }
      }
    );
  } catch (error) {
    console.error('adminDoDeleteProduct error:', error);
    await bot.editMessageText(
      `❌ Gagal menghapus produk \`${safeMd(code)}\`.

Kemungkinan masih ada data order terkait.`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🛠️ Admin Shop', callback_data: 'shop_admin_menu' }]] }
      }
    );
  }
}

async function adminPickProduct(bot, chatId, messageId, purpose, cbPrefix) {
  if (!requireAdmin(bot, chatId)) return;

  const products = await db.all('SELECT code, name FROM shop_products ORDER BY name ASC');
  if (!products || products.length === 0) {
    await bot.editMessageText(`${purpose}\n\nBelum ada produk.`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_admin_menu' }]] }
    });
    return;
  }

  const rows = products.map(p => ([{ text: `${p.name} (${p.code})`, callback_data: `${cbPrefix}${p.code}` }]));
  rows.push([{ text: '« Kembali', callback_data: 'shop_admin_menu' }]);

  await bot.editMessageText(purpose, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: rows }
  });
}

async function adminStartSetPrice(bot, chatId, messageId, code, sessionManager) {
  if (!requireAdmin(bot, chatId)) return;

  const p = await db.get('SELECT code, name, price FROM shop_products WHERE code=?', [code]);
  if (!p) {
    await bot.editMessageText('❌ Produk tidak ditemukan.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_admin_pick_price' }]] }
    });
    return;
  }

  await bot.editMessageText(
    `💲 *Ubah Harga*\n\n` +
      `Produk: *${safeMd(p.name)}* \`(${safeMd(p.code)})\`\n` +
      `Harga sekarang: *${formatRupiah(p.price)}*\n\n` +
      `Kirim harga baru (angka saja), contoh: \`15000\``,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Batal', callback_data: 'shop_admin_menu' }]] }
    }
  );

  sessionManager.setAdminSession(chatId, { action: 'shop_set_price', productCode: code, messageId });
}

async function processSetPrice(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  if (!requireAdmin(bot, chatId)) return;

  const adminSession = sessionManager.getAdminSession(chatId);
  const code = adminSession?.productCode;
  const price = parseInt(String(msg.text || '').replace(/[^0-9]/g, ''), 10);

  if (!code || !price || price <= 0) {
    await bot.sendMessage(chatId, '❌ Harga tidak valid. Masukkan angka, contoh: 15000');
    return;
  }

  await db.run('UPDATE shop_products SET price=? WHERE code=?', [price, code]);

  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId, `✅ Harga diupdate untuk \`${safeMd(code)}\` → *${formatRupiah(price)}*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '??️ Admin Shop', callback_data: 'shop_admin_menu' }]] }
  });
}

async function adminStartSetDesc(bot, chatId, messageId, code, sessionManager) {
  if (!requireAdmin(bot, chatId)) return;

  const p = await db.get('SELECT code, name, description FROM shop_products WHERE code=?', [code]);
  if (!p) {
    await bot.editMessageText('❌ Produk tidak ditemukan.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_admin_pick_desc' }]] }
    });
    return;
  }

  await bot.editMessageText(
    `📝 *Set Keterangan*\n\n` +
      `Produk: *${safeMd(p.name)}* \`(${safeMd(p.code)})\`\n\n` +
      `Keterangan saat ini:\n${p.description ? safeMd(p.description) : '_(kosong)_'}\n\n` +
      `Kirim keterangan baru (boleh multi-line).`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Batal', callback_data: 'shop_admin_menu' }]] }
    }
  );

  sessionManager.setAdminSession(chatId, { action: 'shop_set_desc', productCode: code, messageId });
}

async function processSetDesc(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  if (!requireAdmin(bot, chatId)) return;

  const adminSession = sessionManager.getAdminSession(chatId);
  const code = adminSession?.productCode;
  const desc = String(msg.text || '').trim();

  if (!code) {
    sessionManager.clearAdminSession(chatId);
    await bot.sendMessage(chatId, '❌ Session admin tidak valid.');
    return;
  }

  await db.run('UPDATE shop_products SET description=? WHERE code=?', [desc, code]);

  sessionManager.clearAdminSession(chatId);
  await bot.sendMessage(chatId, `✅ Keterangan diupdate untuk \`${safeMd(code)}\`.`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🛠️ Admin Shop', callback_data: 'shop_admin_menu' }]] }
  });
}

function normalizeStockIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

async function findExistingUnsoldStock(productCode, identity) {
  const normalized = normalizeStockIdentity(identity);
  if (!normalized) return null;
  return db.get(
    `SELECT id, email
     FROM shop_stock_items
     WHERE product_code = ?
       AND is_sold = 0
       AND LOWER(TRIM(email)) = ?
     LIMIT 1`,
    [productCode, normalized]
  );
}

function parseStockLines(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];

  // If key-value style single account
  const kv = parseKeyValueBlock(text);
  const maybeEmail = kv.email || kv.mail;
  const maybePass = kv.pass || kv.password;
  if (maybeEmail && maybePass) {
    items.push({
      email: maybeEmail.trim(),
      password: maybePass.trim(),
      twofa: (kv['2fa'] || kv.mfa || kv.otp || '').trim() || null,
      note: (kv.note || kv.noted || kv.ket || '').trim() || null,
      extra: (kv.extra || '').trim() || null
    });
    return items;
  }

  // Bulk lines: email|pass|2fa|note|extra (2fa/note/extra optional)
  for (const line of lines) {
    // allow delimiter | or ;
    const parts = line.split(/[|;]/).map(x => x.trim());
    if (parts.length >= 2) {
      items.push({
        email: parts[0],
        password: parts[1],
        twofa: parts[2] ? parts[2] : null,
        note: parts[3] ? parts[3] : null,
        extra: parts[4] ? parts[4] : null
      });
    }
  }
  return items;
}

async function adminStartAddStock(bot, chatId, messageId, code, sessionManager) {
  if (!requireAdmin(bot, chatId)) return;

  const p = await db.get('SELECT code, name FROM shop_products WHERE code=?', [code]);
  if (!p) {
    await bot.editMessageText('❌ Produk tidak ditemukan.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_admin_pick_add_stock' }]] }
    });
    return;
  }

  await bot.editMessageText(
    `➕ *Tambah Stok*\n\n` +
      `Produk: *${safeMd(p.name)}* \`(${safeMd(p.code)})\`\n\n` +
      `Kirim stok dengan format (boleh banyak baris):\n` +
      '`email|password|2fa(optional)|note(optional)`\n\n' +
      `Contoh:\n` +
      '`a@mail.com|pass123|mfa123|garansi 1x24`\n' +
      '`b@mail.com|pass456`',
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Batal', callback_data: 'shop_admin_menu' }]] }
    }
  );

  sessionManager.setAdminSession(chatId, { action: 'shop_add_stock', productCode: code, messageId });
}

async function processAddStock(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  if (!requireAdmin(bot, chatId)) return;

  const adminSession = sessionManager.getAdminSession(chatId);
  const code = adminSession?.productCode;
  if (!code) {
    sessionManager.clearAdminSession(chatId);
    await bot.sendMessage(chatId, '❌ Session admin tidak valid.');
    return;
  }

  const items = parseStockLines(msg.text);
  if (!items.length) {
    await bot.sendMessage(chatId, '❌ Format stok tidak terbaca. Pastikan minimal `email|password` per baris.');
    return;
  }

  let ok = 0;
  const skipped = [];
  const seenInInput = new Set();

  for (const it of items) {
    if (!it.email || !it.password) continue;

    const identity = normalizeStockIdentity(it.email);
    if (!identity) continue;

    if (seenInInput.has(identity)) {
      skipped.push(`${it.email} (duplikat di input)`);
      continue;
    }
    seenInInput.add(identity);

    const existing = await findExistingUnsoldStock(code, it.email);
    if (existing) {
      skipped.push(`${it.email} (stok ini sudah tersedia)`);
      continue;
    }

    await db.run(
      'INSERT INTO shop_stock_items(product_code, email, password, twofa, note, extra, is_sold) VALUES(?,?,?,?,?,?,0)',
      [code, it.email.trim(), it.password, it.twofa, it.note, it.extra]
    );
    ok += 1;
  }

  sessionManager.clearAdminSession(chatId);
  const stok = await countStock(code);

  let text = '';
  if (ok > 0) {
    text += `✅ Berhasil tambah stok: *${ok}* item.\n`;
  }
  if (skipped.length > 0) {
    text += `⚠️ Stok ini sudah tersedia / duplikat, jadi dilewati: *${skipped.length}* item.\n`;
    text += skipped.slice(0, 20).map(x => `• ${safeMd(x)}`).join('\n');
    if (skipped.length > 20) text += `\n• dan ${skipped.length - 20} lainnya`;
    text += '\n';
  }
  if (!text) text = '❌ Tidak ada stok valid yang bisa ditambahkan.\n';
  text += `Stok sekarang: *${stok}*`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🛠️ Admin Shop', callback_data: 'shop_admin_menu' }]] }
  });
}

async function adminStartDelStock(bot, chatId, messageId, code, sessionManager) {
  if (!requireAdmin(bot, chatId)) return;

  const p = await db.get('SELECT code, name FROM shop_products WHERE code=?', [code]);
  if (!p) {
    await bot.editMessageText('❌ Produk tidak ditemukan.', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'shop_admin_pick_del_stock' }]] }
    });
    return;
  }

  await bot.editMessageText(
    `🗑️ *Hapus Stok*\n\n` +
      `Produk: *${safeMd(p.name)}* \`(${safeMd(p.code)})\`\n\n` +
      `Kirim email yang mau dihapus.\n` +
      `Bisa lebih dari 1, pisahkan dengan koma.\n\n` +
      `Contoh:\n\`a@mail.com\`\n\`a@mail.com, b@mail.com\``,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Batal', callback_data: 'shop_admin_menu' }]] }
    }
  );

  sessionManager.setAdminSession(chatId, { action: 'shop_del_stock', productCode: code, messageId });
}

async function processDelStock(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  if (!requireAdmin(bot, chatId)) return;

  const adminSession = sessionManager.getAdminSession(chatId);
  const code = adminSession?.productCode;
  if (!code) {
    sessionManager.clearAdminSession(chatId);
    await bot.sendMessage(chatId, '❌ Session admin tidak valid.');
    return;
  }

  const emails = String(msg.text || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  if (!emails.length) {
    await bot.sendMessage(chatId, '❌ Email tidak terbaca.');
    return;
  }

  let changes = 0;
  for (const email of emails) {
    const res = await db.run(
      'DELETE FROM shop_stock_items WHERE product_code=? AND email=? AND is_sold=0',
      [code, email]
    );
    changes += Number(res?.changes || 0);
  }

  sessionManager.clearAdminSession(chatId);
  const stok = await countStock(code);
  await bot.sendMessage(chatId, `✅ Hapus stok selesai. Terhapus: *${changes}* item.\nStok sekarang: *${stok}*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🛠️ Admin Shop', callback_data: 'shop_admin_menu' }]] }
  });
}

async function adminStartSetFee(bot, chatId, messageId, sessionManager) {
  if (!requireAdmin(bot, chatId)) return;

  const current = await adminSettings.getNumber('shop_admin_fee_flat', 0);
  await bot.editMessageText(
    `⚙️ *Set Admin Fee Shop*\n\n` +
      `Fee saat ini: *${formatRupiah(current)}*\n\n` +
      `Kirim angka fee baru (contoh: \`0\` atau \`1500\`).`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Batal', callback_data: 'shop_admin_menu' }]] }
    }
  );

  sessionManager.setAdminSession(chatId, { action: 'shop_set_fee', messageId });
}

async function processSetFee(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  if (!requireAdmin(bot, chatId)) return;

  const fee = parseInt(String(msg.text || '').replace(/[^0-9]/g, ''), 10);
  if (isNaN(fee) || fee < 0) {
    await bot.sendMessage(chatId, '❌ Fee tidak valid. Masukkan angka >= 0.');
    return;
  }

  await adminSettings.set('shop_admin_fee_flat', String(fee));
  sessionManager.clearAdminSession(chatId);

  await bot.sendMessage(chatId, `✅ Fee shop di-set ke *${formatRupiah(fee)}*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🛠️ Admin Shop', callback_data: 'shop_admin_menu' }]] }
  });
}

module.exports = {
  showShopMenu,
  listProducts,
  showProduct,
  startBuy,
  handleQtyInput,
  refreshShopPayment,
  cancelShopPayment,
  // Admin
  showShopAdminMenu,
  adminListProducts,
  adminStartAddProduct,
  processAddProduct,
  adminPromptDeleteProduct,
  adminConfirmDeleteProduct,
  adminDoDeleteProduct,
  adminPickProduct,
  adminStartSetPrice,
  processSetPrice,
  adminStartSetDesc,
  processSetDesc,
  adminStartAddStock,
  processAddStock,
  adminStartDelStock,
  processDelStock,
  adminStartSetFee,
  processSetFee
};
