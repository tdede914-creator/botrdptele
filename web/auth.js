/**
 * Autentikasi website KOBONG CLOUD SERVER.
 *
 * Model identitas bot = Telegram ID saja (tidak ada password). Maka website
 * memakai **Telegram Login Widget**: browser mendapatkan objek user +hash dari
 * Telegram, server memvalidasi hash memakai bot token (algoritma resmi
 * Telegram), lalu menerbitkan cookie sesi ber-tanda-tangan (HMAC).
 *
 * Referensi algoritma: https://core.telegram.org/widgets/login#checking-authorization
 */
const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari
const AUTH_MAX_AGE_SEC = 24 * 60 * 60;          // login payload dianggap valid 24 jam

/**
 * Verifikasi payload Telegram Login Widget.
 * @param {object} data - berisi id, first_name, username, auth_date, hash, dst.
 * @param {string} botToken - TELEGRAM_BOT_TOKEN
 * @returns {boolean}
 */
function verifyTelegramLogin(data, botToken) {
  if (!data || !botToken) return false;
  const { hash, ...fields } = data;
  if (!hash) return false;

  const checkString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');

  const secret = crypto.createHash('sha256').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  // Bandingkan aman terhadap timing attack.
  const a = Buffer.from(hmac);
  const b = Buffer.from(String(hash));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const authDate = Number(fields.auth_date || 0);
  if (!authDate) return false;
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > AUTH_MAX_AGE_SEC || ageSec < -300) return false; // kadaluarsa / clock skew

  return true;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Buat token sesi ber-tanda-tangan berisi { tid, exp }. */
function createSessionToken(telegramId, secret) {
  const payload = { tid: String(telegramId), exp: Date.now() + SESSION_TTL_MS };
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(p).digest());
  return `${p}.${sig}`;
}

/** Verifikasi token sesi. Return payload {tid, exp} atau null. */
function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const p = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', secret).update(p).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!obj || !obj.tid || !obj.exp || Number(obj.exp) < Date.now()) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

module.exports = {
  verifyTelegramLogin,
  createSessionToken,
  verifySessionToken,
  SESSION_TTL_MS
};
