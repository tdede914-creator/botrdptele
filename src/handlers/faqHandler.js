async function handleFAQ(bot, chatId, messageId) {
  const faqText = `FAQ - Pertanyaan Umum

Cara Mengatasi Account RDP di Locked:

1. Mengatur Account Lockout Threshold Jadi Nol
- Tekan Windows + R
- Ketik secpol.msc
- Buka Account Policies > Account Lockout Policy
- Set Account lockout threshold ke 0

2. Ubah Port RDP dari Default (3389)
- Tekan Windows + R
- Ketik regedit
- Ke HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Terminal Server\\WinStations\\RDP-Tcp
- Ubah PortNumber ke port baru (misal: 50000)

3. Atur Firewall untuk Port Baru
- Buka Windows Firewall (wf.msc)
- Tambahkan Inbound dan Outbound Rules
- Izinkan koneksi untuk port baru

Restart server untuk menerapkan perubahan.`;

  await bot.editMessageText(faqText, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '« Kembali', callback_data: 'back_to_menu' }
      ]]
    }
  });
}

module.exports = {
  handleFAQ
};