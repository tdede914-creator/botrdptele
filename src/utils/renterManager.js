const db = require('../config/database');
const { getAccountEmail, isLinodeToken, isAwsToken, isUpCloudToken, makeAwsToken, providerName } = require('./doApi');

let initialized = false;
async function ensureTables() {
  if (initialized) return;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS renters (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS renter_do_api (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      email TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, token)
    );

    CREATE TABLE IF NOT EXISTS renter_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      droplet_id INTEGER,
      ip TEXT,
      size_slug TEXT,
      region TEXT,
      image TEXT,
      root_password TEXT,
      rdp_password TEXT,
      windows_version TEXT,
      api_id INTEGER,
      created_at INTEGER NOT NULL,
      status INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS renter_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS renter_pending_payments (
      transaction_id TEXT PRIMARY KEY,
      unique_code TEXT,
      user_id INTEGER NOT NULL,
      plan TEXT NOT NULL,
      days INTEGER NOT NULL,
      price INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      balance_used INTEGER NOT NULL DEFAULT 0,
      expiry_time INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_renter_api_user_status ON renter_do_api(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_renter_instances_user ON renter_instances(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_renter_pending_user ON renter_pending_payments(user_id, status);
  `);
  try { await db.run('ALTER TABLE renter_instances ADD COLUMN api_id INTEGER'); } catch (_) {}
  // rdp_port: port RDP per-instance (UpCloud=3389 karena firewall default-nya
  // allow 3389 bukan 4443; provider lain=4443). Fallback 4443 di display.
  try { await db.run('ALTER TABLE renter_instances ADD COLUMN rdp_port INTEGER'); } catch (_) {}
  // Tier support: 'basic' | 'premium'. Existing rows default to 'basic'.
  try { await db.run("ALTER TABLE renters ADD COLUMN tier TEXT NOT NULL DEFAULT 'basic'"); } catch (_) {}
  try { await db.run("ALTER TABLE renter_pending_payments ADD COLUMN tier TEXT NOT NULL DEFAULT 'basic'"); } catch (_) {}
  initialized = true;
}

function normalizeTier(tier) {
  const t = String(tier || '').toLowerCase();
  return t === 'premium' ? 'premium' : 'basic';
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizeProviderToken(token, provider = 'digitalocean') {
  const clean = String(token || '').trim();
  if (!clean) return '';
  if (isLinodeToken(clean) || isAwsToken(clean) || isUpCloudToken(clean)) return clean;
  const p = String(provider || '').toLowerCase();
  if (p === 'linode') return `linode:${clean}`;
  if (p === 'aws') {
    const parts = clean.split('|').map(x => x.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error('INVALID_AWS_FORMAT');
    return makeAwsToken(parts[0], parts[1], parts[2] || 'us-east-1');
  }
  if (p === 'upcloud') {
    // UpCloud token sudah punya format sendiri (ucat_xxxx). Kalau tidak match,
    // artinya user paste yang salah.
    if (!isUpCloudToken(clean)) throw new Error('INVALID_UPCLOUD_TOKEN');
    return clean;
  }
  return clean;
}

// Tier-aware pricing. Basic keeps the legacy keys (`rent_*_price`) untouched so
// upgrades don't lose prior admin settings. Premium uses new keys
// (`rent_premium_*_price`) and defaults to roughly 2x basic since premium unlocks
// Cloud9 and Fastpanel install + auto-order.
const BASIC_PRICE_KEYS = {
  daily: 'rent_daily_price',
  weekly: 'rent_weekly_price',
  monthly: 'rent_monthly_price'
};
const PREMIUM_PRICE_KEYS = {
  daily: 'rent_premium_daily_price',
  weekly: 'rent_premium_weekly_price',
  monthly: 'rent_premium_monthly_price'
};
const BASIC_DEFAULTS = { daily: 10000, weekly: 50000, monthly: 150000 };
const PREMIUM_DEFAULTS = { daily: 20000, weekly: 100000, monthly: 300000 };

function priceKeysForTier(tier) {
  return normalizeTier(tier) === 'premium' ? PREMIUM_PRICE_KEYS : BASIC_PRICE_KEYS;
}
function defaultsForTier(tier) {
  return normalizeTier(tier) === 'premium' ? PREMIUM_DEFAULTS : BASIC_DEFAULTS;
}

async function getRentPrices(tier = 'basic') {
  await ensureTables();
  const t = normalizeTier(tier);
  const keys = priceKeysForTier(t);
  const defaults = defaultsForTier(t);
  const rows = await db.all(
    'SELECT key, value FROM renter_settings WHERE key IN (?, ?, ?)',
    [keys.daily, keys.weekly, keys.monthly]
  );
  const map = {};
  for (const r of rows || []) map[r.key] = Number(r.value || 0);
  return {
    tier: t,
    daily: map[keys.daily] || defaults.daily,
    weekly: map[keys.weekly] || defaults.weekly,
    monthly: map[keys.monthly] || defaults.monthly
  };
}

async function getAllTierPrices() {
  const [basic, premium] = await Promise.all([
    getRentPrices('basic'),
    getRentPrices('premium')
  ]);
  return { basic, premium };
}

async function setRentPrices(tierOrDaily, dailyOrWeekly, weeklyOrMonthly, monthlyMaybe) {
  await ensureTables();
  // Backward compatible signature: setRentPrices(daily, weekly, monthly) -> basic.
  // New signature: setRentPrices(tier, daily, weekly, monthly).
  let tier = 'basic';
  let daily, weekly, monthly;
  if (typeof tierOrDaily === 'string') {
    tier = normalizeTier(tierOrDaily);
    daily = dailyOrWeekly;
    weekly = weeklyOrMonthly;
    monthly = monthlyMaybe;
  } else {
    daily = tierOrDaily;
    weekly = dailyOrWeekly;
    monthly = weeklyOrMonthly;
  }
  const keys = priceKeysForTier(tier);
  const ts = nowSec();
  const items = [
    [keys.daily, Number(daily)],
    [keys.weekly, Number(weekly)],
    [keys.monthly, Number(monthly)]
  ];
  for (const [key, value] of items) {
    if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_PRICE');
    await db.run(
      'INSERT INTO renter_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, String(value), ts]
    );
  }
  return getRentPrices(tier);
}

async function addPendingRentPayment(data) {
  await ensureTables();
  await db.run('DELETE FROM renter_pending_payments WHERE user_id = ? AND status = ?', [Number(data.userId), 'pending']);
  const tier = normalizeTier(data.tier);
  await db.run(
    'INSERT INTO renter_pending_payments (transaction_id, unique_code, user_id, plan, days, price, amount, balance_used, expiry_time, status, created_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [data.transactionId, data.uniqueCode, Number(data.userId), data.plan, Number(data.days), Number(data.price), Number(data.amount), Number(data.balanceUsed || 0), Number(data.expiryTime), 'pending', nowSec(), tier]
  );
}

async function getPendingRentPayment(userId) {
  await ensureTables();
  return await db.get('SELECT * FROM renter_pending_payments WHERE user_id = ? AND status = ? AND expiry_time > ? ORDER BY created_at DESC LIMIT 1', [Number(userId), 'pending', Date.now()]);
}

async function getRentPaymentByTransaction(transactionId) {
  await ensureTables();
  return await db.get('SELECT * FROM renter_pending_payments WHERE transaction_id = ? OR unique_code = ? LIMIT 1', [transactionId, transactionId]);
}

async function markRentPaymentStatus(transactionId, status) {
  await ensureTables();
  await db.run('UPDATE renter_pending_payments SET status = ? WHERE transaction_id = ? OR unique_code = ?', [status, transactionId, transactionId]);
}

async function cleanupExpiredRentPayments() {
  await ensureTables();
  return await db.all('SELECT * FROM renter_pending_payments WHERE status = ? AND expiry_time <= ?', ['pending', Date.now()]);
}

async function addRenter(userId, days, tierOrUsername = 'basic', maybeUsername = null) {
  await ensureTables();
  // Backward compatible: addRenter(userId, days, username) still works (legacy admin flow).
  // New signature: addRenter(userId, days, tier, username).
  let tier = 'basic';
  let username = null;
  if (typeof tierOrUsername === 'string' && (tierOrUsername === 'basic' || tierOrUsername === 'premium')) {
    tier = normalizeTier(tierOrUsername);
    username = maybeUsername;
  } else {
    // Legacy call: 3rd arg is username, no tier.
    username = tierOrUsername || null;
  }

  const uid = Number(userId);
  const d = Number(days);
  if (!uid || !d || d <= 0) throw new Error('INVALID_FORMAT');
  const existing = await db.get('SELECT expires_at, tier FROM renters WHERE user_id = ?', [uid]);

  // If the renter is renewing while still active, keep the higher tier
  // (upgrades stack additively — if they had premium and buy basic, tier stays premium).
  const existingActive = existing && Number(existing.expires_at) > nowSec();
  const effectiveTier = existingActive && normalizeTier(existing.tier) === 'premium' ? 'premium' : tier;

  const base = existingActive ? Number(existing.expires_at) : nowSec();
  const expiresAt = base + (d * 86400);
  const ts = nowSec();
  await db.run(
    `INSERT INTO renters (user_id, username, expires_at, tier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username   = COALESCE(excluded.username, renters.username),
       expires_at = excluded.expires_at,
       tier       = excluded.tier,
       updated_at = excluded.updated_at`,
    [uid, username, expiresAt, effectiveTier, ts, ts]
  );
  return { userId: uid, expiresAt, tier: effectiveTier };
}

async function removeRenter(userId) {
  await ensureTables();
  await db.run('DELETE FROM renters WHERE user_id = ?', [Number(userId)]);
}

async function updateRenterUsername(userId, username) {
  await ensureTables();
  if (!username) return;
  await db.run('UPDATE renters SET username = ?, updated_at = ? WHERE user_id = ?', [username, nowSec(), Number(userId)]);
}

async function getRenter(userId) {
  await ensureTables();
  return await db.get('SELECT * FROM renters WHERE user_id = ?', [Number(userId)]);
}

async function isActiveRenter(userId) {
  const row = await getRenter(userId);
  return !!(row && Number(row.expires_at) > nowSec());
}

async function getRenterTier(userId) {
  const row = await getRenter(userId);
  if (!row || Number(row.expires_at) <= nowSec()) return null;
  return normalizeTier(row.tier);
}

async function isPremiumRenter(userId) {
  return (await getRenterTier(userId)) === 'premium';
}

async function listRenters() {
  // Hanya tampilkan penyewa AKTIF (belum expired). Yang sudah expired
  // otomatis di-hide dari admin "List Penyewa" biar list ringkas.
  await ensureTables();
  const now = Math.floor(Date.now() / 1000);
  return await db.all(
    'SELECT * FROM renters WHERE expires_at > ? ORDER BY expires_at ASC',
    [now]
  );
}

async function listAllRenters() {
  // Semua penyewa (aktif + expired). Dipakai untuk keperluan internal
  // seperti hapus penyewa lama, audit, dsb.
  await ensureTables();
  return await db.all('SELECT * FROM renters ORDER BY expires_at DESC');
}

async function countActiveRenters() {
  await ensureTables();
  const row = await db.get('SELECT COUNT(*) AS total FROM renters WHERE expires_at > ?', [nowSec()]);
  return Number(row && row.total ? row.total : 0);
}

async function countMonthlyRenters() {
  await ensureTables();
  const startOfMonth = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000);
  const row = await db.get('SELECT COUNT(*) AS total FROM renters WHERE expires_at > ? AND updated_at >= ?', [nowSec(), startOfMonth]);
  const monthly = Number(row && row.total ? row.total : 0);
  return monthly > 0 ? monthly : await countActiveRenters();
}

async function addApi(userId, token, provider = 'digitalocean') {
  await ensureTables();
  const clean = normalizeProviderToken(token, provider);
  if (!clean) throw new Error('EMPTY_TOKEN');
  let email = null;
  try { email = await getAccountEmail(clean); } catch (_) {}
  const existing = await db.get('SELECT id, status FROM renter_do_api WHERE user_id = ? AND token = ?', [Number(userId), clean]);
  if (existing && existing.id) {
    await db.run('UPDATE renter_do_api SET status = 1, email = COALESCE(?, email) WHERE id = ?', [email, existing.id]);
    return { id: existing.id, email, exists: true, provider: providerName(clean) };
  }
  const res = await db.run('INSERT INTO renter_do_api (user_id, token, email, status, created_at) VALUES (?, ?, ?, 1, ?)', [Number(userId), clean, email, nowSec()]);
  return { id: res && res.id, email, exists: false, provider: providerName(clean) };
}

async function listApis(userId, activeOnly = false) {
  await ensureTables();
  const rows = activeOnly
    ? await db.all('SELECT id, user_id, token, email, status, created_at FROM renter_do_api WHERE user_id = ? AND status = 1 ORDER BY id DESC', [Number(userId)])
    : await db.all('SELECT id, user_id, token, email, status, created_at FROM renter_do_api WHERE user_id = ? ORDER BY id DESC', [Number(userId)]);
  return (rows || []).map(r => ({
    id: r.id,
    user_id: r.user_id,
    email: r.email,
    status: r.status,
    created_at: r.created_at,
    provider: providerName(r.token),
    provider_key: isAwsToken(r.token) ? 'aws' : (isLinodeToken(r.token) ? 'linode' : (isUpCloudToken(r.token) ? 'upcloud' : 'digitalocean'))
  }));
}

async function getApiToken(userId, apiId) {
  await ensureTables();
  // Utamakan API yang aktif. Jika data hasil restore punya api_id lama/status tidak aktif,
  // tetap izinkan fallback ke token dengan id tersebut agar aksi hapus/rebuild tidak buntu.
  let row = await db.get('SELECT token FROM renter_do_api WHERE user_id = ? AND id = ? AND status = 1', [Number(userId), Number(apiId)]);
  if (!row) row = await db.get('SELECT token FROM renter_do_api WHERE user_id = ? AND id = ?', [Number(userId), Number(apiId)]);
  return row && row.token;
}

async function getDefaultApiToken(userId) {
  await ensureTables();
  // Utamakan API aktif. Jika tidak ada yang aktif setelah restore, pakai API terakhir yang tersedia.
  let row = await db.get('SELECT token FROM renter_do_api WHERE user_id = ? AND status = 1 ORDER BY id DESC LIMIT 1', [Number(userId)]);
  if (!row) row = await db.get('SELECT token FROM renter_do_api WHERE user_id = ? ORDER BY id DESC LIMIT 1', [Number(userId)]);
  return row && row.token;
}

async function getBestApiToken(userId, apiId = null) {
  await ensureTables();
  if (apiId) {
    const token = await getApiToken(userId, apiId);
    if (token) return token;
  }
  return await getDefaultApiToken(userId);
}

async function deleteApi(userId, apiId) {
  await ensureTables();
  await db.run('DELETE FROM renter_do_api WHERE user_id = ? AND id = ?', [Number(userId), Number(apiId)]);
}

async function disableApi(userId, apiId) {
  await ensureTables();
  await db.run('UPDATE renter_do_api SET status = 0 WHERE user_id = ? AND id = ?', [Number(userId), Number(apiId)]);
}

async function saveInstance(data) {
  await ensureTables();
  await db.run(
    `INSERT INTO renter_instances
     (user_id, type, droplet_id, ip, size_slug, region, image, root_password, rdp_password, windows_version, api_id, rdp_port, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [data.userId, data.type, data.dropletId || null, data.ip || null, data.sizeSlug || null, data.region || null, data.image || null, data.rootPassword || null, data.rdpPassword || null, data.windowsVersion || null, data.apiId || null, data.rdpPort || null, nowSec()]
  );
}

async function listInstances(userId) {
  await ensureTables();
  return await db.all('SELECT * FROM renter_instances WHERE user_id = ? AND status = 1 ORDER BY id DESC LIMIT 20', [Number(userId)]);
}


async function getInstance(userId, instanceId) {
  await ensureTables();
  return await db.get('SELECT * FROM renter_instances WHERE user_id = ? AND id = ? AND status = 1', [Number(userId), Number(instanceId)]);
}

async function markInstanceDeleted(userId, instanceId) {
  await ensureTables();
  await db.run('UPDATE renter_instances SET status = 0 WHERE user_id = ? AND id = ?', [Number(userId), Number(instanceId)]);
}

async function updateInstanceDroplet(userId, instanceId, data) {
  await ensureTables();
  await db.run(
    'UPDATE renter_instances SET droplet_id = ?, ip = ?, region = ?, image = ?, root_password = ?, rdp_password = COALESCE(?, rdp_password), windows_version = COALESCE(?, windows_version), api_id = COALESCE(?, api_id), rdp_port = COALESCE(?, rdp_port) WHERE user_id = ? AND id = ?',
    [data.dropletId || null, data.ip || null, data.region || null, data.image || null, data.rootPassword || null, data.rdpPassword || null, data.windowsVersion || null, data.apiId || null, data.rdpPort || null, Number(userId), Number(instanceId)]
  );
}

async function updateInstancePassword(userId, instanceId, password, field = 'root') {
  await ensureTables();
  if (field === 'rdp') {
    await db.run('UPDATE renter_instances SET rdp_password = ? WHERE user_id = ? AND id = ?', [password, Number(userId), Number(instanceId)]);
  } else {
    await db.run('UPDATE renter_instances SET root_password = ? WHERE user_id = ? AND id = ?', [password, Number(userId), Number(instanceId)]);
  }
}

async function exportBackup(userId) {
  await ensureTables();
  const renter = await getRenter(userId);
  const apis = await db.all('SELECT id, token, email, status, created_at FROM renter_do_api WHERE user_id = ? ORDER BY id ASC', [Number(userId)]);
  const instances = await db.all('SELECT * FROM renter_instances WHERE user_id = ? ORDER BY id ASC', [Number(userId)]);
  return { version: 1, type: 'renter_backup', exported_at: nowSec(), user_id: Number(userId), renter, apis, instances };
}

async function importBackup(userId, backup) {
  await ensureTables();
  if (!backup || backup.type !== 'renter_backup') throw new Error('INVALID_BACKUP');
  const uid = Number(userId);
  const ts = nowSec();
  const renter = backup.renter || {};
  if (renter.expires_at) {
    await db.run(
      'INSERT INTO renters (user_id, username, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username = COALESCE(excluded.username, renters.username), expires_at = MAX(renters.expires_at, excluded.expires_at), updated_at = excluded.updated_at',
      [uid, renter.username || null, Number(renter.expires_at), Number(renter.created_at) || ts, ts]
    );
  }
  const apiIdMap = {};
  const backupApis = backup.apis || [];
  const hasActiveBackupApi = backupApis.some(a => Number(a.status) !== 0);
  for (let i = 0; i < backupApis.length; i++) {
    const a = backupApis[i];
    if (!a.token) continue;
    // Kalau backup lama semua API statusnya nonaktif, aktifkan API pertama supaya renter bisa langsung hapus/rebuild.
    const restoredStatus = hasActiveBackupApi ? (Number(a.status) === 0 ? 0 : 1) : (i === 0 ? 1 : 0);
    let existing = await db.get('SELECT id FROM renter_do_api WHERE user_id = ? AND token = ?', [uid, a.token]);
    if (existing && existing.id) {
      await db.run('UPDATE renter_do_api SET email = COALESCE(?, email), status = CASE WHEN status = 1 THEN 1 ELSE ? END WHERE id = ?', [a.email || null, restoredStatus, existing.id]);
      apiIdMap[String(a.id)] = existing.id;
    } else {
      const res = await db.run('INSERT INTO renter_do_api (user_id, token, email, status, created_at) VALUES (?, ?, ?, ?, ?)', [uid, a.token, a.email || null, restoredStatus, Number(a.created_at) || ts]);
      apiIdMap[String(a.id)] = res && res.id;
    }
  }
  for (const x of (backup.instances || [])) {
    const mappedApiId = x.api_id ? (apiIdMap[String(x.api_id)] || x.api_id) : null;
    await db.run(
      'INSERT INTO renter_instances (user_id, type, droplet_id, ip, size_slug, region, image, root_password, rdp_password, windows_version, api_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uid, x.type || 'vps', x.droplet_id || null, x.ip || null, x.size_slug || null, x.region || null, x.image || null, x.root_password || null, x.rdp_password || null, x.windows_version || null, mappedApiId, Number(x.created_at) || ts, Number(x.status) === 0 ? 0 : 1]
    );
  }
  const activeApi = await db.get('SELECT id FROM renter_do_api WHERE user_id = ? AND status = 1 LIMIT 1', [uid]);
  if (!activeApi) {
    await db.run('UPDATE renter_do_api SET status = 1 WHERE id = (SELECT id FROM renter_do_api WHERE user_id = ? ORDER BY id DESC LIMIT 1)', [uid]);
  }
}

function formatDate(ts) {
  if (!ts) return '-';
  return new Date(Number(ts) * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
}

module.exports = {
  ensureTables,
  normalizeTier,
  getRentPrices,
  getAllTierPrices,
  setRentPrices,
  getRenterTier,
  isPremiumRenter,
  addPendingRentPayment,
  getPendingRentPayment,
  getRentPaymentByTransaction,
  markRentPaymentStatus,
  cleanupExpiredRentPayments,
  addRenter,
  removeRenter,
  updateRenterUsername,
  getRenter,
  isActiveRenter,
  listRenters,
  listAllRenters,
  countActiveRenters,
  countMonthlyRenters,
  addApi,
  listApis,
  getApiToken,
  getDefaultApiToken,
  getBestApiToken,
  deleteApi,
  disableApi,
  saveInstance,
  listInstances,
  getInstance,
  markInstanceDeleted,
  updateInstanceDroplet,
  updateInstancePassword,
  exportBackup,
  importBackup,
  formatDate
};
