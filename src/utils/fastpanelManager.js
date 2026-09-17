const db = require('../config/database');

function formatRp(n) {
  return 'Rp ' + Number(n || 0).toLocaleString('id-ID');
}

function formatDateShort(sec) {
  if (!sec) return '-';
  const d = new Date(Number(sec) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

let columnCache = null;

async function getProductColumns() {
  if (columnCache) return columnCache;
  try {
    const cols = await db.all('PRAGMA table_info(vps_products)');
    columnCache = new Set(cols.map(c => c.name));
  } catch (_) {
    columnCache = new Set();
  }
  return columnCache;
}

/**
 * Ensure the columns Fastpanel relies on are present in vps_products.
 * These are already added by Cloud9, but we run this defensively so Fastpanel
 * still works on older bot databases where Cloud9 was never installed.
 */
async function ensureFastpanelColumns() {
  const cols = await getProductColumns();
  const adds = [
    ['price_daily', 'INTEGER DEFAULT 0'],
    ['price_weekly', 'INTEGER DEFAULT 0'],
    ['slot_daily', 'INTEGER DEFAULT 0'],
    ['slot_weekly', 'INTEGER DEFAULT 0'],
    ['slot_monthly', 'INTEGER DEFAULT 0']
  ];

  for (const [name, def] of adds) {
    if (!cols.has(name)) {
      try {
        await db.run(`ALTER TABLE vps_products ADD COLUMN ${name} ${def}`);
      } catch (_) {}
    }
  }

  columnCache = null;
}

/**
 * List all active cloud APIs across providers (DigitalOcean/Linode/AWS).
 * Fastpanel supports all three because Fastpanel is just an Ubuntu/Debian
 * install after the VPS boots.
 */
async function listAllActiveApis() {
  const rows = await db.all('SELECT * FROM do_api WHERE status = 1 ORDER BY id DESC');
  return Array.isArray(rows) ? rows : [];
}

function apiProviderKey(apiRow) {
  const t = String(apiRow?.token || '');
  if (t.startsWith('aws:')) return 'aws';
  if (t.startsWith('linode:')) return 'linode';
  return 'digitalocean';
}

function providerLabel(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'aws') return '🟠 AWS';
  if (p === 'linode') return '🟣 Linode';
  return '🌊 DigitalOcean';
}

async function listActiveProducts() {
  await ensureFastpanelColumns();
  return await db.all(`
    SELECT p.*, a.email, a.token
    FROM vps_products p
    JOIN do_api a ON a.id = p.api_id AND a.status = 1
    WHERE p.status = 1 AND p.product_type = 'fastpanel'
      AND (COALESCE(p.slot_weekly,0) > 0 OR COALESCE(p.slot_monthly,0) > 0 OR COALESCE(p.slot,0) > 0)
    ORDER BY p.ram ASC, p.core ASC, p.price ASC, p.id ASC
  `);
}

async function listAllProducts() {
  await ensureFastpanelColumns();
  return await db.all(`
    SELECT p.*, a.email, a.token
    FROM vps_products p
    LEFT JOIN do_api a ON a.id = p.api_id
    WHERE p.product_type = 'fastpanel'
    ORDER BY p.status DESC, p.id DESC
  `);
}

async function getProduct(productId) {
  await ensureFastpanelColumns();
  return await db.get(`
    SELECT p.*, a.email, a.token
    FROM vps_products p
    JOIN do_api a ON a.id = p.api_id
    WHERE p.id = ? AND p.product_type = 'fastpanel'
  `, [productId]);
}

async function addProduct({ apiId, sizeSlug, ram, core, price = 170000, stock = 1, priceWeekly = 50000, stockWeekly = 0 }) {
  await ensureFastpanelColumns();

  const existing = await db.get(`
    SELECT id, slot, slot_weekly, slot_monthly
    FROM vps_products
    WHERE api_id = ? AND product_type = 'fastpanel' AND size_slug = ? AND ram = ? AND core = ?
    LIMIT 1
  `, [apiId, sizeSlug, Number(ram), Number(core)]);

  if (existing) {
    await db.run(`
      UPDATE vps_products
      SET price = ?,
          price_weekly = ?,
          slot_weekly = COALESCE(slot_weekly,0) + ?,
          slot_monthly = COALESCE(slot_monthly,0) + ?,
          slot = COALESCE(slot,0) + ? + ?,
          status = 1
      WHERE id = ?
    `, [Number(price), Number(priceWeekly || 0), Number(stockWeekly || 0), Number(stock || 0), Number(stockWeekly || 0), Number(stock || 0), existing.id]);

    return existing.id;
  }

  const res = await db.run(`
    INSERT INTO vps_products
      (api_id, product_type, size_slug, ram, core, price, price_daily, price_weekly, slot, slot_daily, slot_weekly, slot_monthly, status)
    VALUES (?, 'fastpanel', ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, 1)
  `, [
    apiId,
    sizeSlug,
    Number(ram),
    Number(core),
    Number(price),
    Number(priceWeekly || 0),
    Number(stock || 0) + Number(stockWeekly || 0),
    Number(stockWeekly || 0),
    Number(stock || 0)
  ]);

  return res?.lastID;
}

async function updateProductPrice(productId, priceMonthly, priceWeekly = null) {
  await ensureFastpanelColumns();
  await db.run(
    'UPDATE vps_products SET price = ?, price_weekly = COALESCE(?, price_weekly) WHERE id = ? AND product_type = "fastpanel"',
    [Number(priceMonthly), priceWeekly == null ? null : Number(priceWeekly), productId]
  );
}

async function decrementStock(productId, durationDays = 30) {
  await ensureFastpanelColumns();
  const col = Number(durationDays) === 7 ? 'slot_weekly' : 'slot_monthly';
  await db.run(`
    UPDATE vps_products
    SET ${col} = CASE WHEN COALESCE(${col},0) > 0 THEN ${col} - 1 ELSE 0 END,
        slot = CASE WHEN COALESCE(slot,0) > 0 THEN slot - 1 ELSE 0 END
    WHERE id = ? AND product_type = 'fastpanel'
  `, [productId]);
}

async function incrementStock(productId, durationDays = 30) {
  await ensureFastpanelColumns();
  const col = Number(durationDays) === 7 ? 'slot_weekly' : 'slot_monthly';
  await db.run(`
    UPDATE vps_products
    SET ${col} = COALESCE(${col},0) + 1,
        slot = COALESCE(slot,0) + 1
    WHERE id = ? AND product_type = 'fastpanel'
  `, [productId]);
}

async function deleteProduct(productId) {
  await ensureFastpanelColumns();
  // Soft delete only. Existing instances may still reference this product row via FK.
  await db.run(`
    UPDATE vps_products
    SET status = 0,
        slot = 0,
        slot_weekly = 0,
        slot_monthly = 0
    WHERE id = ? AND product_type = 'fastpanel'
  `, [productId]);
}

async function listActiveFastpanelInstances() {
  return await db.all(`
    SELECT *
    FROM vps_instances
    WHERE deleted_at IS NULL AND image LIKE 'fastpanel:%'
    ORDER BY expires_at ASC, id DESC
  `);
}

async function listExpiredFastpanelInstances(limit = 20) {
  const now = Math.floor(Date.now() / 1000);
  return await db.all(`
    SELECT *
    FROM vps_instances
    WHERE deleted_at IS NULL
      AND status = 1
      AND image LIKE 'fastpanel:%'
      AND expires_at IS NOT NULL
      AND expires_at > 0
      AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT ?
  `, [now, Number(limit) || 20]);
}

async function markFastpanelDeleted(instanceId) {
  const now = Math.floor(Date.now() / 1000);
  return await db.run(
    'UPDATE vps_instances SET status = 0, deleted_at = ? WHERE id = ? AND image LIKE "fastpanel:%"',
    [now, instanceId]
  );
}

async function getFastpanelInstance(instanceId) {
  return await db.get('SELECT * FROM vps_instances WHERE id = ? AND image LIKE "fastpanel:%"', [instanceId]);
}

module.exports = {
  formatRp,
  formatDateShort,
  ensureFastpanelColumns,
  listAllActiveApis,
  apiProviderKey,
  providerLabel,
  listActiveProducts,
  listAllProducts,
  getProduct,
  addProduct,
  updateProductPrice,
  decrementStock,
  incrementStock,
  deleteProduct,
  listActiveFastpanelInstances,
  listExpiredFastpanelInstances,
  markFastpanelDeleted,
  getFastpanelInstance
};
