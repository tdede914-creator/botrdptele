const { handlePaymentStatus } = require('../utils/paymentStatus');
const { createPayment, checkPaymentStatus, isPaymentStatusSuccessful } = require('../utils/payment');
const BalanceManager = require('./balanceHandler');
const PaymentTracker = require('../utils/paymentTracker');
const { getUser } = require('../utils/userManager');
const binanceApi = require('../utils/binanceApi');
const QRCode = require('qrcode');

/**
 * Entry to the deposit flow. Shows a method picker: QRIS or Crypto (USDT).
 *
 * Behavior change vs earlier versions: this function used to ask for the
 * deposit amount directly. Amount input is now under `handleDepositQris`,
 * so the picker screen is the new default landing page. Callers that were
 * expecting a session object back should treat `null` as "no session needed
 * yet — user still has to pick a method".
 */
async function handleDeposit(bot, chatId, messageId) {
  // Show crypto option only when Binance API keys are configured, so we
  // don't advertise a payment method that will fail at verification time.
  const cryptoRow = binanceApi.isConfigured()
    ? [[{ text: '🪙 Crypto USDT (Binance)', callback_data: 'crypto_deposit_menu' }]]
    : [];

  const inline_keyboard = [
    [{ text: '💳 QRIS (Rupiah)', callback_data: 'deposit_qris' }],
    ...cryptoRow,
    [{ text: '« Kembali', callback_data: 'back_to_menu' }]
  ];

  await bot.editMessageText(
    '💰 *Deposit Saldo*\n\n' +
    'Pilih metode pembayaran:\n\n' +
    '• *QRIS* — semua e-wallet Indonesia (GoPay, OVO, DANA, ShopeePay, dst).\n' +
    (binanceApi.isConfigured()
      ? '• *Crypto USDT* — Binance Pay ID atau USDT BEP20. Auto-verify via TX-ID.'
      : '_(Crypto belum aktif — admin belum set Binance API.)_'),
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard }
    }
  );

  // No session is set here — the flow branches based on which button the
  // user picks. Amount input is only requested after they choose QRIS.
  return null;
}

/**
 * QRIS-specific entry. Same behavior as the previous `handleDeposit`: ask
 * for amount, then create the QRIS invoice. Kept as a separate function so
 * the picker can dispatch here on demand.
 */
async function handleDepositQris(bot, chatId, messageId) {
  const msg = await bot.editMessageText(
    '💳 *Deposit via QRIS*\n\n' +
    'Masukkan jumlah deposit:\n' +
    '(minimal Rp 1.000)',
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '« Ganti Metode', callback_data: 'deposit' }
        ]]
      }
    }
  );

  const session = {
    step: 'waiting_amount',
    messageId: msg.message_id
  };
  return session;
}

async function handleDepositAmount(bot, msg, session) {
  const chatId = msg.chat.id;
  const amount = parseInt(msg.text.replace(/[^0-9]/g, ''));

  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (error) {
    console.log('Failed to delete amount message:', error.message);
  }

  if (isNaN(amount) || amount < 1000) {
    await bot.editMessageText(
      'Jumlah deposit tidak valid.\n\n' +
      'Deposit Saldo\n\n' +
      'Masukkan jumlah deposit:\n' +
      '(minimal Rp 1.000)',
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '« Kembali', callback_data: 'back_to_menu' }
          ]]
        }
      }
    );
    return;
  }

  await bot.editMessageText(
    'Membuat tagihan pembayaran QRIS...',
    {
      chat_id: chatId,
      message_id: session.messageId,
      parse_mode: 'Markdown'
    }
  );

  try {
    await getUser(chatId);
    const uniqueCode = `DEP${Date.now()}${chatId}`;

    console.log('Creating payment with:', {
      apiKey: process.env.DOMPETX_API_KEY ? '***' : 'undefined',
      uniqueCode,
      amount
    });

    const payment = await createPayment(process.env.DOMPETX_API_KEY, uniqueCode, amount);

    console.log('Payment creation result:', {
      success: payment.success,
      hasData: !!payment.data,
      error: payment.error
    });

    if (!payment.success) {
      throw new Error(payment.error || 'Gagal membuat pembayaran QRIS');
    }

    if (!payment.data || (!payment.data.qr_string && !payment.data.qr_image && !payment.data.payment_url)) {
      throw new Error('Data pembayaran dari payment gateway tidak lengkap');
    }

    const expiryTime = payment.data.expired_at ?
      new Date(payment.data.expired_at).getTime() :
      Date.now() + (30 * 60 * 1000);

    await PaymentTracker.addPendingPayment(
      chatId,
      payment.data.id,
      payment.data.reff_id,
      amount,
      expiryTime
    );

    const messageText = createDompetXPaymentMessage(payment.data, amount);
    // Sebagian gateway (mis. Valqenix) mengembalikan payment_link, bukan qr_string.
    const qrImageBuffer = payment.data.qr_string ? await generateQrCodeFromString(payment.data.qr_string) : null;

    try {
      await bot.deleteMessage(chatId, session.messageId);
    } catch (deleteError) {
      console.log('Failed to delete loading message:', deleteError.message);
    }

    let sentMessage;
    if (qrImageBuffer) {
      sentMessage = await bot.sendPhoto(chatId, qrImageBuffer, {
        caption: messageText,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Refresh Status', callback_data: 'refresh_payment' }],
            [{ text: 'Batalkan', callback_data: 'cancel_payment' }]
          ]
        }
      });
    } else {
      // Tidak ada QR image (mis. Valqenix pakai payment_link): beri tombol URL "Bayar Sekarang".
      const payUrl = payment.data.payment_url || payment.data.qr_image || null;
      const kb = [];
      if (payUrl) kb.push([{ text: '💳 Bayar Sekarang (QRIS)', url: payUrl }]);
      kb.push([{ text: 'Refresh Status', callback_data: 'refresh_payment' }]);
      kb.push([{ text: 'Batalkan', callback_data: 'cancel_payment' }]);
      sentMessage = await bot.sendMessage(chatId,
        messageText + (payUrl ? '\n\n👉 Tekan *Bayar Sekarang (QRIS)* untuk membuka halaman pembayaran.' : ''),
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
      );
    }

    await handlePaymentStatus(
      bot,
      chatId,
      sentMessage.message_id,
      payment.data.id,
      amount
    );

  } catch (error) {
    console.error('Payment creation error:', error);
    const errorMessage = error.message ? error.message.replace(/[_*`]/g, '\\$&') : 'Unknown error';

    await bot.editMessageText(
      'Gagal membuat pembayaran QRIS. Silakan coba lagi.\n\n' +
      `Error: ${errorMessage}\n\n` +
      `Tips: Pastikan koneksi internet stabil`,
      {
        chat_id: chatId,
        message_id: session.messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Coba Lagi', callback_data: 'deposit_qris' }],
            [{ text: '« Kembali', callback_data: 'back_to_menu' }]
          ]
        }
      }
    );
  }
}

async function generateQrCodeFromString(qrString) {
  try {
    console.log('Generating QR code from string...');
    const qrBuffer = await QRCode.toBuffer(qrString, {
      type: 'png',
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    console.log('QR code generated successfully');
    return qrBuffer;
  } catch (error) {
    console.error('Failed to generate QR code:', error.message);
    return null;
  }
}

async function handlePendingPayment(bot, chatId, messageId) {
  try {
    const pendingPayment = await PaymentTracker.getPendingPayment(chatId);
    if (!pendingPayment) {
      await bot.editMessageText(
        'Tidak ada tagihan pembayaran yang tertunda.',
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '« Kembali', callback_data: 'back_to_menu' }
            ]]
          }
        }
      );
      return;
    }

    const paymentStatus = await checkPaymentStatus(process.env.DOMPETX_API_KEY, pendingPayment.transaction_id);

    if (!paymentStatus.success) {
      throw new Error(paymentStatus.error || 'Failed to get payment status');
    }

    const messageText = createDompetXPendingPaymentMessage(pendingPayment);
    const qrImageUrl = paymentStatus.data?.qr_image || '#';

    await bot.editMessageText(
      messageText + `\n\n[Klik untuk melihat QR Code](${qrImageUrl})`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Refresh Status', callback_data: 'refresh_payment' }],
            [{ text: 'Batalkan', callback_data: 'cancel_payment' }]
          ]
        }
      }
    );

    await handlePaymentStatus(bot, chatId, messageId, pendingPayment.transaction_id, pendingPayment.amount);

  } catch (error) {
    console.error('Error handling pending payment:', error);
    await bot.editMessageText(
      'Terjadi kesalahan saat mengecek tagihan pembayaran.\n\n' +
      `Error: ${error.message}`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '« Kembali', callback_data: 'back_to_menu' }
          ]]
        }
      }
    );
  }
}

function createDompetXPaymentMessage(paymentData, amount) {
  const expiredAt = paymentData.expired_at ? new Date(paymentData.expired_at) : new Date(Date.now() + 30 * 60 * 1000);
  const expiredTime = expiredAt.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  const fee = paymentData.fee || 0;
  const tambahan = paymentData.tambahan || 0;
  const getBalance = paymentData.get_balance || amount;

  return `**💳 Scan QRIS untuk membayar**\n\n` +
    `🆔 **ID Transaksi:** ${paymentData.reff_id || paymentData.id}\n` +
    `💰 **Jumlah:** Rp ${amount.toLocaleString()}\n` +
    `📊 **Fee:** Rp ${fee.toLocaleString()}\n` +
    `👤 **Admin:** Rp ${tambahan.toLocaleString()}\n` +
    `💎 **Saldo Diterima:** Rp ${getBalance.toLocaleString()}\n\n` +
    `⏳ **Berlaku hingga:** ${expiredTime}\n\n` +
    `📝 **Cara Pembayaran:**\n` +
    `1️⃣ Scan QR Code di atas\n` +
    `2️⃣ Gunakan aplikasi e-wallet apapun\n` +
    `3️⃣ Konfirmasi pembayaran\n` +
    `4️⃣Saldo otomatis masuk\n\n` +
    `⚠️ **Jangan tutup halaman ini sampai selesai!**`;
}

function createDompetXPendingPaymentMessage(pendingPayment) {
  const expiredAt = new Date(pendingPayment.expiry_time);
  const expiredTime = expiredAt.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  return `**💳 QRIS Pending**\n\n` +
    `🆔 **ID Transaksi:** ${pendingPayment.unique_code}\n` +
    `💰 **Jumlah:** Rp ${pendingPayment.amount.toLocaleString()}\n` +
    `⏳ **Berlaku hingga:** ${expiredTime}\n\n` +
    `📝 **Cara Pembayaran:**\n` +
    `1️⃣ Scan QR Code\n` +
    `2️⃣ Gunakan aplikasi e-wallet apapun\n` +
    `3️⃣ Konfirmasi pembayaran\n` +
    `4️⃣ Saldo otomatis masuk\n\n` +
    `⏳ **Status:** Menunggu Pembayaran`;
}

module.exports = {
  handleDeposit,
  handleDepositQris,
  handleDepositAmount,
  handlePendingPayment
};