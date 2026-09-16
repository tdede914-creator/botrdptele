/**
 * Web DB bootstrap.
 *
 * Reuses the bot's shared SQLite connection (src/config/database.js) so the
 * website and the Telegram bot read/write EXACTLY the same data (stok, saldo,
 * order, dst tersinkron otomatis).
 *
 * PENTING: database bot default-nya tidak mengaktifkan WAL / busy_timeout,
 * sehingga dua proses (bot + web) yang menulis bersamaan bisa kena
 * SQLITE_BUSY. Di sini kita aktifkan WAL + busy_timeout. WAL bersifat
 * persisten pada file DB, jadi ikut menguntungkan proses bot juga.
 */
const shared = require('../src/config/database');

try {
  // journal_mode=WAL: satu penulis + banyak pembaca bisa berbarengan.
  shared.raw.run('PRAGMA journal_mode = WAL', (err) => {
    if (err) console.error('[web/db] Gagal set WAL:', err.message);
    else console.log('[web/db] SQLite WAL mode aktif.');
  });
  // busy_timeout: penulis menunggu (bukan langsung error) saat DB terkunci.
  shared.raw.run('PRAGMA busy_timeout = 8000', (err) => {
    if (err) console.error('[web/db] Gagal set busy_timeout:', err.message);
  });
} catch (e) {
  console.error('[web/db] PRAGMA setup error:', e.message || e);
}

module.exports = shared;
