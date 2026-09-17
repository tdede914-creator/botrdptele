const { checkPaymentStatus } = require('./payment');
const ShopPaymentTracker = require('./shopPaymentTracker');
const db = require('../config/database');
const { notifyShopSaleDetailed, notifyOrderTestimonial } = require('./orderNotifier');

// Cancelled monitoring marker
const cancelledTransactions = new Set();
// Prevent duplicate monitors / double-fulfillment when user taps Refresh while auto-monitor is running
const activeMonitors = new Set();

function cancelShopPaymentMonitoring(transactionId) {
  if (transactionId) cancelledTransactions.add(transactionId);
  if (transactionId) activeMonitors.delete(transactionId);
}

function isShopPaymentMonitoring(transactionId) {
  return activeMonitors.has(transactionId);
}

function formatRupiah(n) {
  try {
    return `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
  } catch {
    return `Rp ${n}`;
  }
}

function safeMd(text) {
  return String(text || '').replace(/[_*`]/g, '\\$&');
}

async function releaseOrderReservation(orderId) {
  await db.run(
    `UPDATE shop_stock_items
     SET reserved_by_order_id = NULL, reserved_until = NULL
     WHERE is_sold = 0 AND reserved_by_order_id = ?`,
    [orderId]
  );
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

function formatDeliveredItems(productName, items) {
  const lines = ['✅ *Pembayaran Berhasil*', '', `📦 *Produk:* ${safeMd(productName)}`, ''];
  (items || []).forEach((it, idx) => {
    const header = (items.length > 1)
      ? `━━━━━━━━━ *Detail Produk #${idx + 1}* ━━━━━━━━━`
      : '━━━━━━━━━ *Detail Produk* ━━━━━━━━━';
    lines.push(header);
    if (it.email) lines.push(`📧 Email: \`${it.email}\``);
    if (it.password) lines.push(`🔑 Password: \`${it.password}\``);
    if (it.twofa) lines.push(`🔐 2FA: \`${it.twofa}\``);
    if (it.note) lines.push(`📝 Note: ${safeMd(it.note)}`);

    // extra JSON pairs: [[k,v],...]
    if (it.extra) {
      try {
        const extras = JSON.parse(it.extra);
        if (Array.isArray(extras)) {
          for (const pair of extras) {
            if (Array.isArray(pair) && pair.length === 2) {
              const k = String(pair[0] || '').trim();
              const v = String(pair[1] || '').trim();
              if (k && v) lines.push(`• ${safeMd(k)}: \`${v}\``);
            }
          }
        }
      } catch {}
    }
  });

  lines.push('', '🙏 Terima kasih!');
  return lines.join('\n');
}

async function fulfillOrder(bot, chatId, orderId) {
  // Read order
  const order = await db.get('SELECT * FROM shop_orders WHERE id = ?', [orderId]);
  if (!order) throw new Error('Order tidak ditemukan');

  // Idempotency guard: if already processed, do nothing.
  if (['paid', 'delivered'].includes(String(order.status || '').toLowerCase())) {
    return;
  }

  const product = await db.get('SELECT * FROM shop_products WHERE code = ?', [order.product_code]);
  const productName = product?.name || order.product_code;

  // Allocate stock atomically + prevent double fulfill (compare-and-set status)
  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    // Mark as processing only if it was still pending_payment
    const claim = await db.run(
      'UPDATE shop_orders SET status = ? WHERE id = ? AND status = ?',
      ['processing', orderId, 'pending_payment']
    );

    // If nothing updated, another worker already claimed/processed this order.
    if (!claim || claim.changes === 0) {
      await db.exec('ROLLBACK');
      return;
    }

    let items = await db.all(
      `SELECT * FROM shop_stock_items
       WHERE product_code = ?
         AND is_sold = 0
         AND reserved_by_order_id = ?
       ORDER BY id ASC
       LIMIT ?`,
      [order.product_code, orderId, order.qty]
    );

    // Fallback untuk order lama sebelum sistem reserve: ambil stok yang benar-benar bebas.
    if (!items || items.length < order.qty) {
      await cleanupExpiredReservations();
      items = await db.all(
        `SELECT * FROM shop_stock_items
         WHERE product_code = ?
           AND is_sold = 0
           AND (reserved_by_order_id IS NULL OR reserved_by_order_id = ? OR reserved_until IS NULL OR reserved_until <= ?)
         ORDER BY id ASC
         LIMIT ?`,
        [order.product_code, orderId, Date.now(), order.qty]
      );
    }

    if (!items || items.length < order.qty) {
      // Seharusnya tidak terjadi untuk order baru karena stok sudah di-reserve saat invoice dibuat.
      await db.exec('ROLLBACK');
      await db.run('UPDATE shop_orders SET status = ? WHERE id = ?', ['failed_out_of_stock', orderId]);
      await bot.sendMessage(
        chatId,
        '⚠️ Pembayaran terdeteksi berhasil, tapi stok tidak ditemukan. Mohon hubungi admin untuk pengecekan manual.',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]] }
        }
      );
      return;
    }

    const ids = items.map(i => i.id);
    const placeholders = ids.map(() => '?').join(',');
    await db.run(
      `UPDATE shop_stock_items
       SET is_sold = 1, reserved_by_order_id = NULL, reserved_until = NULL
       WHERE id IN (${placeholders})`,
      ids
    );
    await db.run('UPDATE shop_orders SET status = ? WHERE id = ?', ['paid', orderId]);
    await db.exec('COMMIT');

    // Channel #1 (detail) + Channel #2 (testimoni)
    // Both are optional (only sent if env is configured).
    await notifyShopSaleDetailed(bot, {
      productName,
      qty: order.qty,
      amount: order.amount,
      orderId,
      buyer: chatId
    });
    await notifyOrderTestimonial(bot, { productName });

    const delivered = formatDeliveredItems(productName, items);
    await bot.sendMessage(chatId, delivered, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]]
      }
    });
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

async function handleShopPaymentStatus(bot, chatId, messageId, transactionId, orderId, amount, maxRetries = 60) {
  // Avoid spawning multiple monitors for the same transaction.
  if (activeMonitors.has(transactionId)) return;
  activeMonitors.add(transactionId);

  let retryCount = 0;
  const retryInterval = 10000;

  const checkStatus = async () => {
    if (cancelledTransactions.has(transactionId)) {
      cancelledTransactions.delete(transactionId);
      activeMonitors.delete(transactionId);
      return;
    }

    try {
      const statusResult = await checkPaymentStatus(process.env.DOMPETX_API_KEY, transactionId);
      const statusRaw = statusResult?.data?.status;
      const status = (statusRaw || '').toString().toLowerCase();

      const successStatuses = ['success', 'settlement', 'capture', 'paid', 'completed'];
      const failedStatuses = ['failed', 'cancelled', 'expired', 'deny', 'error', 'void'];

      if (successStatuses.includes(status)) {
        await ShopPaymentTracker.removePendingPayment(transactionId);
        cancelledTransactions.delete(transactionId);
        activeMonitors.delete(transactionId);

        // Remove QR message if possible
        try { await bot.deleteMessage(chatId, messageId); } catch {}

        await fulfillOrder(bot, chatId, orderId);
        return;
      }

      if (failedStatuses.includes(status)) {
        await ShopPaymentTracker.removePendingPayment(transactionId);
        cancelledTransactions.delete(transactionId);
        activeMonitors.delete(transactionId);
        await releaseOrderReservation(orderId);
        await db.run('UPDATE shop_orders SET status = ? WHERE id = ?', ['failed', orderId]);
        await bot.sendMessage(
          chatId,
          `❌ *Pembayaran Gagal*\n\n💰 Jumlah: *${formatRupiah(amount)}*\n📋 Status: *${safeMd(status)}*`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🛒 Kembali ke Produk', callback_data: 'shop_list' }],
                [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
              ]
            }
          }
        );
        return;
      }

      retryCount++;
      if (retryCount < maxRetries) {
        setTimeout(checkStatus, retryInterval);
        return;
      }

      await bot.sendMessage(
        chatId,
        `⏰ Monitoring pembayaran dihentikan (timeout).\n\n` +
          `Silakan tekan *Refresh Status* bila sudah bayar.\n` +
          `💰 Jumlah: *${formatRupiah(amount)}*`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Refresh Status', callback_data: `shop_refresh_${orderId}` }],
              [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
            ]
          }
        }
      );
      cancelledTransactions.delete(transactionId);
      activeMonitors.delete(transactionId);
    } catch (e) {
      retryCount++;
      if (retryCount < maxRetries) {
        setTimeout(checkStatus, retryInterval);
        return;
      }
      await bot.sendMessage(chatId, '❌ Error saat monitoring pembayaran. Silakan coba Refresh Status.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh Status', callback_data: `shop_refresh_${orderId}` }],
            [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
          ]
        }
      });
      cancelledTransactions.delete(transactionId);
      activeMonitors.delete(transactionId);
    }
  };

  setTimeout(checkStatus, 1200);
}

module.exports = {
  handleShopPaymentStatus,
  cancelShopPaymentMonitoring,
  isShopPaymentMonitoring
};
