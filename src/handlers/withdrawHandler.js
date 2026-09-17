async function handleWithdrawBalance(bot, chatId, messageId, sessionManager) {
  const accountSession = sessionManager.getAccountSession(chatId);

  if (!accountSession || !accountSession.bankCode || !accountSession.accountNumber || !accountSession.accountHolderName) {
    await bot.editMessageText(
      'Silakan simpan informasi rekening bank Anda terlebih dahulu.',
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '« Kembali ke Menu Atlantic', callback_data: 'atlantic_admin' }
            ]
          ]
        }
      }
    );
    return;
  }

  sessionManager.setWithdrawSession(chatId, { step: 'waiting_withdraw_amount' });

  await bot.editMessageText(
    '💸 Silakan masukkan jumlah yang akan ditarik:',
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '« Batal', callback_data: 'cancel_withdraw' }
          ]
        ]
      }
    }
  );
}

module.exports = {
  handleWithdrawBalance
};