const { addBalance } = require('../utils/userManager');
const { getAllUsers } = require('../utils/userManager');
// Akun website (username otomatis) -> resolusi user_id untuk tambah saldo via bot.
const webAccountService = require('../../web/services/accountService');
const { sendAdminNotification } = require('../utils/adminNotifications');
const axios = require('axios');
const paymentGateway = require('../utils/paymentGateway');
const qs = require('qs');
const { BUTTONS } = require('../config/buttons');

async function handleAddBalance(bot, chatId, messageId) {
  await bot.editMessageText(
    'Masukkan tujuan & jumlah saldo dalam format:\n\n`<user_id / username_web> <jumlah>`\n\n' +
    'Contoh Telegram ID: `123456789 50000`\n' +
    'Contoh akun website: `kcs772ef7 50000`',
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_menu' }]]
      }
    }
  );
}

async function processAddBalance(bot, msg) {
  const parts = String(msg.text || '').trim().split(/\s+/);
  if (parts.length !== 2) {
    await bot.sendMessage(msg.chat.id, '❌ Format tidak valid. Gunakan: `<user_id / username_web> <jumlah>`', {
      parse_mode: 'Markdown'
    });
    return;
  }

  const target = parts[0];
  const amount = parseInt(parts[1]);

  if (isNaN(amount) || amount <= 0) {
    await bot.sendMessage(msg.chat.id, '❌ Jumlah saldo tidak valid.');
    return;
  }

  // Tujuan bisa berupa Telegram ID (angka) ATAU username akun website (mis. kcs772ef7).
  let userId = null;
  let label = target;
  if (/^\d+$/.test(target)) {
    userId = parseInt(target);
  } else {
    try { userId = await webAccountService.getUserIdByUsername(target); } catch (_) { userId = null; }
    if (!userId) {
      await bot.sendMessage(msg.chat.id, `❌ Username website "${target}" tidak ditemukan.`);
      return;
    }
    label = `${target} (akun web)`;
  }

  try {
    const newBalance = await addBalance(userId, amount);
    await bot.sendMessage(msg.chat.id,
      `✅ Berhasil menambahkan saldo:\n\n` +
      `👤 Tujuan: ${label}\n` +
      `🆔 User ID: ${userId}\n` +
      `💰 Jumlah: Rp ${amount.toLocaleString()}\n` +
      `💳 Saldo Baru: Rp ${newBalance.toLocaleString()}`
    );
  } catch (error) {
    console.error('Error adding balance:', error);
    await bot.sendMessage(msg.chat.id, '❌ Gagal menambahkan saldo. Pastikan tujuan (User ID / username web) benar.');
  }
}

async function handleBroadcast(bot, chatId, messageId) {
  await bot.editMessageText(
    '📢 *Broadcast*\n\n' +
    'Silakan kirim *pesan apa saja* yang ingin di-broadcast ke semua pengguna.\n' +
    '✅ Bisa teks, emoji, *format Telegram*, foto, video, dokumen, dll.\n' +
    '_Pesan akan dikirim ulang dengan format yang sama (copy message)._',
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_menu' }]]
      }
    }
  );
}

async function processBroadcast(bot, msg) {
  try {
    const users = await getAllUsers();
    let successCount = 0;
    let failCount = 0;

    await bot.sendMessage(msg.chat.id, '📤 Memulai broadcast...');

    for (const user of users) {
      try {
        await bot.copyMessage(user.telegram_id, msg.chat.id, msg.message_id);
        successCount++;
      } catch (err) {
        failCount++;
        // Ignore blocked / deactivated users
      }

      // Avoid hitting Telegram flood limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    await bot.sendMessage(
      msg.chat.id,
      `✅ *Broadcast Selesai*\n\n` +
      `📨 Terkirim: ${successCount}\n` +
      `❌ Gagal: ${failCount}`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error broadcasting:', error);
    await bot.sendMessage(msg.chat.id, '❌ Terjadi kesalahan saat broadcast.');
  }
}
async function handleAtlanticAdmin(bot, chatId, messageId) {
  const activeGateway = paymentGateway.getActiveGateway();
  const cfg = paymentGateway.getPakasirConfig();
  const message =
    `💳 *Menu Payment*\n\n` +
    `Gateway aktif: *${activeGateway === 'pakasir' ? 'Pakasir' : 'DompetX'}*\n\n` +
    `DompetX: ${process.env.DOMPETX_API_KEY ? '✅ API key tersedia' : '❌ DOMPETX\\_API\\_KEY belum diisi'}\n` +
    `Pakasir: ${(cfg.slug && cfg.apiKey) ? '✅ Slug/API key tersedia' : '❌ PAKASIR\\_SLUG / PAKASIR\\_API\\_KEY belum diisi'}\n\n` +
    `Untuk ganti gateway, ubah .env lalu restart bot:\n` +
    `\`PAYMENT_GATEWAY=dompetx\`\n` +
    `atau\n` +
    `\`PAYMENT_GATEWAY=pakasir\``;
  return bot.editMessageText(message, {
    chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'back_to_menu' }]] }
  });
}

module.exports = {
  handleAddBalance,
  processAddBalance,
  handleBroadcast,
  processBroadcast,
  handleAtlanticAdmin
};
