const fs = require('fs');
const path = require('path');
const vpsManager = require('../utils/vpsManager');
const backupManager = require('../utils/backupManager');
const { isAdmin } = require('../utils/userManager');
const safeMessageEditor = require('../utils/safeMessageEdit');

const restoreUploadSessions = new Map();
const rdpBackupPasswordSessions = new Map();

function isRdpVps(vps) {
  return String(vps?.image || '').startsWith('rdp:') ||
    String(vps?.product_type || '').toLowerCase() === 'rdp';
}

function fmtBytes(n) {
  const x = Number(n || 0);
  if (x >= 1024 * 1024 * 1024) return (x / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (x >= 1024 * 1024) return (x / 1024 / 1024).toFixed(2) + ' MB';
  if (x >= 1024) return (x / 1024).toFixed(2) + ' KB';
  return x + ' B';
}


function backupDownloadName(vps, vpsId) {
  const ip = String(vps?.ip || '').trim();
  const safeIp = ip ? ip.replace(/[^0-9a-zA-Z.-]+/g, '_').replace(/\./g, '_') : `server_${vpsId}`;
  return `${safeIp}.zip`;
}

async function checkAccess(chatId, vpsId) {
  const vps = await backupManager.getManagedServer(vpsId);
  if (!vps || Number(vps.status) !== 1) throw new Error('Server tidak ditemukan.');
  if (!isAdmin(chatId) && Number(vps.user_id) !== Number(chatId)) throw new Error('Akses ditolak.');
  return vps;
}

async function showBackupMenu(bot, chatId, messageId, vpsId) {
  try {
    const vps = await checkAccess(chatId, vpsId);
    const rec = await backupManager.getBackupRecord(vpsId);
    const enabled = await backupManager.isAutoBackupEnabled(vpsId);
    const type = backupManager.serverType(vps).toUpperCase();
    const hasFile = rec?.file_path && fs.existsSync(rec.file_path);
    const date = rec?.created_at ? new Date(Number(rec.created_at) * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB' : '-';
    const size = rec?.file_size ? fmtBytes(rec.file_size) : '-';
    const lastErr = rec?.last_error ? `\n⚠️ Error terakhir: ${String(rec.last_error).slice(0, 250)}` : '';
    const text =
      `📦 *BACKUP ${type}*\n\n` +
      `🌐 IP: *${vps.ip || '-'}*\n` +
      `🕒 Backup terakhir: *${date}*\n` +
      `📁 Ukuran: *${size}*${lastErr}\n\n` +
      (type === 'RDP'
        ? `Folder RDP yang dibackup:\n• Desktop\n• Documents\n• Downloads`
        : `Folder VPS yang dibackup:\n• /root\n• /home\n• /var/www\n• config web server jika ada`);

    const kb = [
      [{ text: '📦 Backup Sekarang', callback_data: `backup_now:${vpsId}` }],
      [{ text: '⬇️ Download Backup', callback_data: `backup_download:${vpsId}` }],
      [{ text: '🔄 Restore Data', callback_data: `backup_restore_ask:${vpsId}` }],      [{ text: '🗑️ Hapus Backup', callback_data: `backup_delete:${vpsId}` }],
      [{ text: '« Kembali', callback_data: `srv_view:${vpsId}` }]
    ];
    return safeMessageEditor.editMessage(bot, chatId, messageId, text, { reply_markup: { inline_keyboard: kb } });
  } catch (e) {
    return bot.sendMessage(chatId, '❌ ' + (e.message || e));
  }
}

async function runBackupNow(bot, chatId, messageId, vpsId) {
  try {
    const vps = await checkAccess(chatId, vpsId);

    if (isRdpVps(vps)) {
      rdpBackupPasswordSessions.set(Number(chatId), { action: 'backup_now', vpsId: Number(vpsId), messageId, createdAt: Date.now() });
      return safeMessageEditor.editMessage(bot, chatId, messageId,
        `🔐 Masukkan password RDP terbaru untuk backup.\n\nIP: ${vps.ip || '-'}\nUsername: Administrator\n\nPassword hanya dipakai untuk backup ini dan tidak disimpan.`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `backup_menu:${vpsId}` }]] } }
      );
    }

    await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ Backup sedang dibuat. Mohon tunggu...', { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] } });
    const res = await backupManager.createBackup(vpsId, { manual: true });
    await bot.sendMessage(chatId, `✅ Backup berhasil dibuat.\n\nUkuran: ${fmtBytes(res.size)}\nTipe: ${res.type.toUpperCase()}`);
  } catch (e) {
    await bot.sendMessage(chatId, '❌ Backup gagal.\nReason: ' + String(e.message || e).slice(0, 700));
  }
}


async function downloadBackup(bot, chatId, messageId, vpsId) {
  let tmpSendPath = null;
  try {
    const vps = await checkAccess(chatId, vpsId);
    const rec = await backupManager.getBackupRecord(vpsId);

    if (!rec?.file_path || !fs.existsSync(rec.file_path)) {
      return bot.sendMessage(chatId, '❌ Backup belum tersedia. Klik Backup Sekarang dulu. Untuk RDP, bot akan meminta password RDP terbaru.');
    }

    const fileName = backupDownloadName(vps, vpsId);
    const tmpDir = path.join(process.cwd(), 'tmp_backup_send');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    tmpSendPath = path.join(tmpDir, fileName);
    try { if (fs.existsSync(tmpSendPath)) fs.unlinkSync(tmpSendPath); } catch (_) {}
    fs.copyFileSync(rec.file_path, tmpSendPath);

    await bot.sendDocument(chatId, tmpSendPath, {
      caption: `📦 Backup server #${vpsId}\nIP: ${vps.ip || '-'}\nUkuran: ${fmtBytes(rec.file_size)}`
    });

    // Setelah berhasil dikirim, hapus backup yang tersimpan di bot agar tidak menumpuk.
    await backupManager.deleteBackup(vpsId);
  } catch (e) {
    await bot.sendMessage(chatId, '❌ Download backup gagal.\nReason: ' + String(e.message || e).slice(0, 900));
  } finally {
    try { if (tmpSendPath && fs.existsSync(tmpSendPath)) fs.unlinkSync(tmpSendPath); } catch (_) {}
  }
}


async function askRestore(bot, chatId, messageId, vpsId) {
  try {
    const vps = await checkAccess(chatId, vpsId);
    restoreUploadSessions.set(Number(chatId), { vpsId: Number(vpsId), createdAt: Date.now() });
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      `🔄 Restore Data ${backupManager.serverType(vps).toUpperCase()}\n\n` +
      `Silakan kirim file backup .zip lama ke chat ini.\n\n` +
      `Target IP: ${vps.ip || '-'}\n` +
      `Catatan RDP: pastikan OpenSSH/port 22 di RDP baru sudah aktif.`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: `backup_menu:${vpsId}` }]] } }
    );
  } catch (e) { return bot.sendMessage(chatId, '❌ ' + (e.message || e)); }
}

async function restoreBackup(bot, chatId, messageId, vpsId) {
  try {
    await checkAccess(chatId, vpsId);
    await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ Restore backup sedang diproses...', { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'back_to_menu' }]] } });
    const res = await backupManager.restoreLatestBackup(vpsId);
    await bot.sendMessage(chatId, `✅ Restore backup selesai.\nTipe: ${res.type.toUpperCase()}\nIP: ${res.ip}`);
  } catch (e) {
    await bot.sendMessage(chatId, '❌ Restore gagal.\nReason: ' + String(e.message || e).slice(0, 700));
  }
}

async function toggleAuto(bot, chatId, messageId, vpsId, enabled) {
  return bot.sendMessage(chatId, '⚙️ Auto Backup sudah dinonaktifkan. Backup sekarang hanya manual dengan password RDP terbaru.');
}

async function deleteBackup(bot, chatId, messageId, vpsId) {
  try {
    await checkAccess(chatId, vpsId);
    await backupManager.deleteBackup(vpsId);
    await bot.sendMessage(chatId, '✅ Backup berhasil dihapus.');
  } catch (e) { await bot.sendMessage(chatId, '❌ Hapus backup gagal.\nReason: ' + (e.message || e)); }
}

async function handleRestoreUpload(bot, msg) {
  const chatId = msg.chat.id;
  const sess = restoreUploadSessions.get(Number(chatId));
  if (!sess || !msg.document) return false;

  try {
    await checkAccess(chatId, sess.vpsId);

    const fileName = msg.document.file_name || '';
    if (!fileName.toLowerCase().endsWith('.zip')) {
      await bot.sendMessage(chatId, '❌ File harus format .zip hasil backup.');
      return true;
    }

    const maxMb = Number(process.env.RESTORE_MAX_MB || 900);
    if (msg.document.file_size && msg.document.file_size > maxMb * 1024 * 1024) {
      await bot.sendMessage(chatId, `❌ File terlalu besar. Maksimal ${maxMb} MB.`);
      return true;
    }

    const tempDir = path.join(process.cwd(), 'tmp_restore_uploads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    await bot.sendMessage(chatId, '⏳ File diterima. Restore sedang diproses...');
    const downloaded = await bot.downloadFile(msg.document.file_id, tempDir);

    const res = await backupManager.restoreBackupFile(sess.vpsId, downloaded, { manualUpload: true });

    restoreUploadSessions.delete(Number(chatId));
    try { if (downloaded && fs.existsSync(downloaded)) fs.unlinkSync(downloaded); } catch (_) {}

    await bot.sendMessage(chatId, `✅ Restore data selesai.\nTipe: ${res.type.toUpperCase()}\nIP: ${res.ip}`);
    return true;
  } catch (e) {
    restoreUploadSessions.delete(Number(chatId));
    await bot.sendMessage(chatId, '❌ Restore upload gagal.\nReason: ' + String(e.message || e).slice(0, 900));
    return true;
  }
}


async function handleRdpBackupPassword(bot, msg) {
  const chatId = msg.chat.id;
  const sess = rdpBackupPasswordSessions.get(Number(chatId));
  if (!sess || !msg.text) return false;

  const password = String(msg.text || '').trim();
  if (!password) {
    await bot.sendMessage(chatId, '❌ Password tidak boleh kosong.');
    return true;
  }

  try {
    try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
    await checkAccess(chatId, sess.vpsId);
    const waitMsg = await bot.sendMessage(chatId, '⏳ Backup RDP sedang dibuat menggunakan password yang kamu kirim...');

    const res = await backupManager.createBackup(sess.vpsId, {
      manual: true,
      password,
      username: 'Administrator'
    });

    rdpBackupPasswordSessions.delete(Number(chatId));

    await bot.sendMessage(chatId, `✅ Backup RDP berhasil dibuat.\n\nUkuran: ${fmtBytes(res.size)}\nIP: ${res.ip || '-'}\n\nSilakan klik Download Backup untuk mengambil file zip.`);
    try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}
    return true;
  } catch (e) {
    rdpBackupPasswordSessions.delete(Number(chatId));
    await bot.sendMessage(chatId, '❌ Backup RDP gagal.\nReason: ' + String(e.message || e).slice(0, 900));
    return true;
  }
}


module.exports = { showBackupMenu, runBackupNow, downloadBackup, askRestore, restoreBackup, toggleAuto, deleteBackup, handleRestoreUpload, handleRdpBackupPassword };
