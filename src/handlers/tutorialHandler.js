async function handleTutorial(bot, chatId, messageId) {
  const tutorialText = `📚 *Tutorial Penggunaan Bot*

1️⃣ *Persiapan VPS*
• Siapkan VPS dengan OS Ubuntu 22.04 fresh install
• Pastikan Anda memiliki akses root
• Catat IP dan password VPS

2️⃣ *Deposit Saldo*
• Klik tombol 💰 Deposit
• Masukkan jumlah deposit (min. Rp 10.000)
• Scan QR code atau gunakan link pembayaran
• Tunggu konfirmasi otomatis

3️⃣ *Instalasi RDP*
• Klik tombol 🖥️ Install RDPmu
• Masukkan IP VPS
• Masukkan password root
• Pilih versi Windows
• Masukkan password RDP
• Tunggu proses instalasi (30-40 menit)

4️⃣ *Penggunaan RDP*
• Gunakan aplikasi Remote Desktop
• Masukkan IP VPS
• Username: admin
• Password: sesuai yang Anda set
• Port default: 4443

5️⃣ *Troubleshooting*
• Lihat menu ❓ FAQ untuk masalah umum
• Cek 🏢 Provider untuk rekomendasi VPS
• Hubungi admin jika butuh bantuan`;

  await bot.editMessageText(tutorialText, {
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
  handleTutorial
};