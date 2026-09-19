/**
 * Akun web (username + password) — alternatif login selain Telegram.
 * Setiap akun web dipetakan ke satu "user id" numerik (disimpan sebagai
 * users.telegram_id) supaya langsung kompatibel dengan sistem saldo/instance/
 * order yang sudah ada. Id akun web memakai offset besar agar tidak bentrok
 * dengan Telegram ID asli.
 */
const crypto = require('crypto');
const db = require('../../src/config/database');
const { getUser } = require('../../src/utils/userManager');

const WEB_ID_BASE = 900000000000; // 9e11: jauh di atas ruang Telegram user id

let ready = false;
async function ensureTable() {
  if (ready) return;
  await db.exec(`CREATE TABLE IF NOT EXISTS web_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    user_id INTEGER,
    created_at INTEGER
  )`);
  ready = true;
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${dk}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, dk] = String(stored).split(':');
    if (!salt || !dk) return false;
    const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(dk); const b = Buffer.from(check);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

function genUsername() { return 'kcs' + crypto.randomBytes(3).toString('hex'); } // kcs + 6 hex
function genPassword() {
  // 10 karakter alfanumerik yang mudah dibaca
  return crypto.randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) + '9';
}

// Daftar akun baru: generate username+password acak. Return { ok, userId, username, password }.
async function register() {
  await ensureTable();
  let username = genUsername();
  for (let i = 0; i < 5; i++) {
    const exist = await db.get('SELECT id FROM web_users WHERE username = ?', [username]);
    if (!exist) break;
    username = genUsername();
  }
  const password = genPassword();
  const passHash = hashPassword(password);
  const now = Math.floor(Date.now() / 1000);
  const res = await db.run('INSERT INTO web_users (username, pass_hash, user_id, created_at) VALUES (?, ?, ?, ?)', [username, passHash, 0, now]);
  const rowId = res && res.id;
  if (!rowId) return { ok: false, error: 'Gagal membuat akun.' };
  const userId = WEB_ID_BASE + Number(rowId);
  await db.run('UPDATE web_users SET user_id = ? WHERE id = ?', [userId, rowId]);
  try { await getUser(userId); } catch (_) {} // buat baris users (untuk FK saldo/instance)
  return { ok: true, userId, username, password };
}

// Login dengan username+password. Return { ok, userId, username }.
async function login(username, password) {
  await ensureTable();
  const u = String(username || '').trim().toLowerCase();
  if (!u || !password) return { ok: false, error: 'Username & password wajib diisi.' };
  const row = await db.get('SELECT * FROM web_users WHERE username = ?', [u]);
  if (!row || !verifyPassword(password, row.pass_hash)) return { ok: false, error: 'Username atau password salah.' };
  try { await getUser(row.user_id); } catch (_) {}
  return { ok: true, userId: row.user_id, username: row.username };
}

// Ambil username dari user_id (untuk ditampilkan). Return string|null.
async function getUsername(userId) {
  try {
    await ensureTable();
    const row = await db.get('SELECT username FROM web_users WHERE user_id = ?', [userId]);
    return row ? row.username : null;
  } catch (_) { return null; }
}

function isWebAccount(userId) { return Number(userId) >= WEB_ID_BASE; }

// Cari user_id (sintetis) dari username akun web. Return number|null.
// Dipakai bot: admin bisa tambah saldo user website via username.
async function getUserIdByUsername(username) {
  try {
    await ensureTable();
    const u = String(username || '').trim().toLowerCase();
    if (!u) return null;
    const row = await db.get('SELECT user_id FROM web_users WHERE username = ?', [u]);
    return row && row.user_id ? Number(row.user_id) : null;
  } catch (_) { return null; }
}

module.exports = { register, login, getUsername, getUserIdByUsername, isWebAccount, WEB_ID_BASE };
