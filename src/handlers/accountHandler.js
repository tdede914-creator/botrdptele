const { BUTTONS } = require('../config/buttons');

async function handleSaveAccount(bot, chatId, messageId, sessionManager) {
  sessionManager.setAccountSession(chatId, { step: 'waiting_bank_selection' });

  await bot.editMessageText(
    '🏦 Silakan pilih bank:',
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [
            BUTTONS.BCA,
            BUTTONS.SEABANK
          ],
          [
            { text: '« Cancel', callback_data: 'cancel_save_account' }
          ]
        ]
      }
    }
  );
}

module.exports = {
  handleSaveAccount
};