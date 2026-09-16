const { checkPaymentStatus, isPaymentStatusSuccessful } = require('./payment');
const BalanceManager = require('../handlers/balanceHandler');
const PaymentTracker = require('./paymentTracker');

// Track cancelled monitoring so scheduled timeouts can exit early.
// This avoids the "Batalkan" button feeling like it does nothing.
const cancelledTransactions = new Set();

function cancelPaymentMonitoring(transactionId) {
  if (transactionId) cancelledTransactions.add(transactionId);
}

async function sendOrEditMessage(bot, chatId, messageId, text, options = {}) {
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      ...options
    };

    // Deposit QR is usually a PHOTO with CAPTION, not a text message.
    // Try caption edit first, then fallback to text edit.
    try {
      await bot.editMessageCaption(text, payload);
    } catch (captionErr) {
      await bot.editMessageText(text, payload);
    }

    console.log('Message edited successfully');
  } catch (editError) {
    console.log('Edit message failed, sending new message instead:', editError.message);
    
    try {
      const newMessage = await bot.sendMessage(chatId, text, options);
      console.log('New message sent successfully');
      return newMessage;
    } catch (sendError) {
      console.error('Failed to send new message:', sendError.message);
      throw sendError;
    }
  }
  return null;
}

async function handlePaymentStatus(bot, chatId, messageId, transactionId, amount, maxRetries = 60) {
  let retryCount = 0;
  const retryInterval = 10000;

  const checkStatus = async () => {
    // Stop if user/admin cancelled monitoring.
    if (cancelledTransactions.has(transactionId)) {
      console.log(`🛑 Payment monitoring cancelled for transaction: ${transactionId}`);
      cancelledTransactions.delete(transactionId);
      return;
    }
    try {
      console.log(`\n=== Payment Status Check ${retryCount + 1}/${maxRetries} ===`);
      console.log(`Transaction ID: ${transactionId}`);
      console.log(`Amount: ${amount}`);
      
      const statusResult = await checkPaymentStatus(process.env.DOMPETX_API_KEY, transactionId);

      console.log('Full status result:', JSON.stringify(statusResult, null, 2));

      if (statusResult && statusResult.success && statusResult.data) {
        const status = statusResult.data.status;
        console.log(`Raw status value: "${status}"`);
        console.log(`Status type: ${typeof status}`);
        
        if (status) {
          const statusLower = status.toString().toLowerCase();
          console.log(`Status lowercase: "${statusLower}"`);
          
          const successStatuses = ['success', 'settlement', 'capture', 'paid', 'completed'];
          const isSuccessStatus = successStatuses.includes(statusLower);
          
          console.log(`Is success status: ${isSuccessStatus}`);
          console.log(`Success statuses: ${successStatuses.join(', ')}`);
          
          if (isSuccessStatus) {
            console.log('🎉 PAYMENT SUCCESS DETECTED - Processing...');
            
            try {
              const balanceToAdd = statusResult.data.get_balance ? 
                parseInt(statusResult.data.get_balance) : amount;
              
              console.log(`Balance to add: ${balanceToAdd}`);
              
              console.log('Updating balance...');
              const balanceResult = await BalanceManager.updateBalance(chatId, balanceToAdd);
              console.log('Balance update result:', balanceResult);
              
              console.log('Removing pending payment...');
              await PaymentTracker.removePendingPayment(transactionId);
              console.log('Pending payment removed');

              // Clean cancel marker if any
              cancelledTransactions.delete(transactionId);

              const statusText = statusLower === 'processing' ? 'Diproses' : 'Berhasil';

              console.log('Sending success message...');
              
              const successMessage = `✅ **Pembayaran Sukses!**\n\n` +
                `💰 **Jumlah:** Rp ${balanceToAdd.toLocaleString()}\n` +
                `💎 **Saldo berhasil ditambahkan ke akun Anda**\n\n` +
                `📅 **Waktu:** ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n` +
                `📋 **Status:** Sukses\n\n` +
                `🎉 **Terima kasih atas pembayaran Anda!**`;
              
              // Delete the QR/photo message so it doesn't remain stuck in chat.
              try { await bot.deleteMessage(chatId, messageId); } catch (_) {}

              await bot.sendMessage(chatId, successMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }
                  ]]
                }
              });
              
              console.log(`✅ Payment successfully confirmed - Status: ${status}, Amount: ${balanceToAdd}, ChatId: ${chatId}`);
              return;
              
            } catch (balanceError) {
              console.error('❌ Error processing payment success:', balanceError);
              
              const errorMessage = `⚠️ **Pembayaran Berhasil - Perlu Verifikasi Manual**\n\n` +
                `💰 **Jumlah:** Rp ${amount.toLocaleString()}\n` +
                `📋 **Status:** ${status}\n` +
                `❗ **Info:** Saldo mungkin butuh update manual\n\n` +
                `📞 **Hubungi admin jika saldo belum bertambah.**`;
              
              await sendOrEditMessage(bot, chatId, messageId, errorMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }
                  ]]
                }
              });
              
              return;
            }
          }
          
          else if (['pending', 'created', 'active'].includes(statusLower)) {
            console.log(`⏳ Payment still pending: ${status}`);
          }
          
          else if (['failed', 'cancelled', 'expired', 'deny', 'error'].includes(statusLower)) {
            console.log(`❌ Payment failed: ${status}`);
            
            await PaymentTracker.removePendingPayment(transactionId);
            cancelledTransactions.delete(transactionId);
            
            const failedMessage = `❌ **Pembayaran Gagal**\n\n` +
              `💰 **Jumlah:** Rp ${amount.toLocaleString()}\n` +
              `📋 **Status:** ${status}\n` +
              `⏰ **Waktu:** ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n\n` +
              `💡 **Silakan coba lagi untuk melakukan deposit.**`;

            await sendOrEditMessage(bot, chatId, messageId, failedMessage, {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Coba Lagi', callback_data: 'deposit' }],
                  [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
                ]
              }
            });
            
            return;
          }
          
          else {
            console.log(`❓ Unknown payment status: ${status} - continuing to monitor`);
          }
        }
      } else {
        console.log('❌ Status check failed or no success flag:', statusResult?.error || 'No error message');
      }

      retryCount++;
      if (retryCount < maxRetries) {
        console.log(`⏳ Scheduling next check in ${retryInterval/1000} seconds...`);
        setTimeout(checkStatus, retryInterval);
      } else {
        console.log('⏰ Monitoring timeout reached');
        
        const timeoutMessage = `⏰ **Monitoring Pembayaran Dihentikan**\n\n` +
          `💰 **Jumlah:** Rp ${amount.toLocaleString()}\n` +
          `📋 **Status:** Monitoring timeout setelah ${Math.round(maxRetries * retryInterval / 60000)} menit\n\n` +
          `💡 **Catatan:**\n` +
          `• Jika sudah membayar, saldo akan otomatis masuk\n` +
          `• Gunakan "Cek Status" untuk monitoring manual\n` +
          `• Hubungi support jika ada kendala`;

        await sendOrEditMessage(bot, chatId, messageId, timeoutMessage, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Cek Status', callback_data: 'pending_payment' }],
              [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
            ]
          }
        });

        cancelledTransactions.delete(transactionId);
      }

    } catch (error) {
      console.error('💥 Error in payment status check:', error);
      retryCount++;
      if (retryCount < maxRetries) {
        console.log(`🔄 Retrying after error in ${retryInterval/1000} seconds...`);
        setTimeout(checkStatus, retryInterval);
      } else {
        const errorMessage = `❌ **Error Monitoring Pembayaran**\n\n` +
          `💰 **Jumlah:** Rp ${amount.toLocaleString()}\n` +
          `📋 **Error:** ${error.message}\n\n` +
          `💡 **Silakan coba cek status manual atau hubungi support.**`;

        await sendOrEditMessage(bot, chatId, messageId, errorMessage, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Cek Status', callback_data: 'pending_payment' }],
              [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
            ]
          }
        });

        cancelledTransactions.delete(transactionId);
      }
    }
  };

  console.log('🚀 Starting payment monitoring in 10 seconds...');
  setTimeout(checkStatus, 10000);
}

module.exports = {
  handlePaymentStatus,
  cancelPaymentMonitoring
};