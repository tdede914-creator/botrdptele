const fs = require('fs');
const path = require('path');
const { scheduleJob } = require('node-schedule');
const { isAdmin } = require('./userManager');
const db = require('../config/database');

class DatabaseBackup {
  constructor(bot) {
    this.bot = bot;
    this.dbPath = path.join(__dirname, '../rdp.db');
    this.backupSchedule = '0 0 * * 0'; // Every Sunday at midnight
  }

  /**
   * Produce a consistent point-in-time snapshot of the bot database
   * using SQLite's built-in `VACUUM INTO` command. This is the correct
   * way to hot-copy a running SQLite database: it acquires the right
   * locks internally, flushes page cache, and writes a fully-formed
   * .db file with no partial pages or missing pending transactions.
   *
   * The previous implementation sent `this.dbPath` directly via
   * bot.sendDocument, which streams the live file byte-by-byte while
   * sqlite3 is still writing to it — producing an inconsistent copy
   * that restores with "missing data". Users reported this exact
   * symptom, which is why we switched to VACUUM INTO.
   *
   * @returns {Promise<string>} absolute path of the temp snapshot file
   *   (caller is responsible for deleting it after upload).
   */
  async createSnapshot() {
    // Snapshot lives next to the live DB so it's on the same
    // filesystem (VACUUM INTO fails on cross-device targets).
    const snapshotPath = this.dbPath + '.snapshot_' + Date.now() + '.db';

    // VACUUM INTO refuses to write to an existing file — clean up
    // in case of leftovers from a crashed previous run.
    try { if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath); } catch (_) {}

    // Escape single quotes in the path (SQLite string literal syntax).
    const sqlSafePath = snapshotPath.replace(/'/g, "''");
    await db.exec(`VACUUM INTO '${sqlSafePath}'`);

    if (!fs.existsSync(snapshotPath)) {
      throw new Error('VACUUM INTO completed but snapshot file was not created');
    }
    return snapshotPath;
  }

  async sendBackupToAdmin(targetChatId = null) {
    let snapshotPath = null;
    try {
      const adminId = targetChatId || process.env.ADMIN_ID;
      if (!adminId) {
        console.error('Admin ID not configured');
        return;
      }

      snapshotPath = await this.createSnapshot();
      const stats = fs.statSync(snapshotPath);
      const fileSizeInMB = stats.size / (1024 * 1024);

      await this.bot.sendDocument(adminId, snapshotPath, {
        caption: `📊 *Weekly Database Backup*\n\n` +
                `📅 Date: ${new Date().toLocaleDateString()}\n` +
                `📦 Size: ${fileSizeInMB.toFixed(2)} MB\n` +
                `🔒 Snapshot: consistent (VACUUM INTO)`,
        parse_mode: 'Markdown'
      });

      console.log('Database backup sent successfully');
    } catch (error) {
      console.error('Error sending database backup:', error);
      // Best-effort user feedback if we know who to tell.
      const adminId = targetChatId || process.env.ADMIN_ID;
      if (adminId) {
        try {
          await this.bot.sendMessage(adminId, '❌ Gagal membuat backup database.\nReason: ' + String(error.message || error).slice(0, 500));
        } catch (_) {}
      }
    } finally {
      // Snapshot file is disposable — restore uses the uploaded copy.
      if (snapshotPath) {
        try { fs.unlinkSync(snapshotPath); } catch (_) {}
      }
    }
  }

  scheduleBackup() {
    scheduleJob(this.backupSchedule, () => {
      this.sendBackupToAdmin();
    });
    console.log('Database backup scheduled');
  }

  async handleManageDatabase(chatId, messageId) {
    if (!isAdmin(chatId)) {
      await this.bot.editMessageText(
        '❌ Access denied. Admin only feature.',
        {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: [[
              { text: '« Back', callback_data: 'back_to_menu' }
            ]]
          }
        }
      );
      return;
    }

    await this.bot.editMessageText(
      '📊 *Database Management*\n\n' +
      '• Weekly backups are scheduled every Sunday\n' +
      '• You can request manual backup anytime\n\n' +
      'Choose an option:',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Download Backup Now', callback_data: 'backup_now' }],
            [{ text: '♻️ Restore Backup', callback_data: 'restore_db' }],
            [{ text: '« Back to Menu', callback_data: 'back_to_menu' }]
          ]
        }
      }
    );
  }

  async promptRestore(chatId, messageId) {
    if (!isAdmin(chatId)) {
      await this.bot.editMessageText('❌ Access denied. Admin only feature.', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'back_to_menu' }]] }
      });
      return;
    }

    await this.bot.editMessageText(
      '♻️ *Restore Database*\n\n' +
      'Silakan *kirim file backup* (SQLite .db) ke chat ini sebagai *Document* (bukan foto).\n\n' +
      '⚠️ Catatan:\n' +
      '• Database saat ini akan dibackup dulu otomatis\n' +
      '• Setelah restore, bot akan restart agar data baru terbaca\n\n' +
      'Kirim file sekarang, atau klik Batal.',
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Batal', callback_data: 'cancel_restore_db' }],
            [{ text: '« Back to Menu', callback_data: 'back_to_menu' }]
          ]
        }
      }
    );
  }

}

module.exports = DatabaseBackup;