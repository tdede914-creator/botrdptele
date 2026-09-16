const db = require('../config/database');

async function getSetting(key, defaultValue = null) {
  const row = await db.get('SELECT value FROM admin_settings WHERE key = ?', [key]);
  if (!row) return defaultValue;
  return row.value;
}

async function setSetting(key, value) {
  const str = String(value);
  await db.run(
    `INSERT INTO admin_settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, str]
  );
  return true;
}

async function getNumber(key, defaultValue = 0) {
  const v = await getSetting(key, null);
  if (v === null || v === undefined) return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

module.exports = {
  getSetting,
  setSetting,
  getNumber
};
