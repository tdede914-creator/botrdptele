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

async function hasColumn(name) {
  const cols = await getProductColumns();
  return cols.has(name);
}

async function ensureCloud9Columns() {
  // Kolom lama bot biasanya tidak punya price_monthly.
  // Cloud9 cukup pakai price untuk 30 hari dan price_weekly untuk 7 hari.
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

async function listAwsApis() {
  const rows = await db.all('SELECT * FROM do_api WHERE status = 1 ORDER BY id DESC');
  return rows.filter(r => String(r.token || '').startsWith('aws:'));
}

async function listActiveProducts() {
  await ensureCloud9Columns();
  return await db.all(`
    SELECT p.*, a.email, a.token
    FROM vps_products p
    JOIN do_api a ON a.id = p.api_id AND a.status = 1
    WHERE p.status = 1 AND p.product_type = 'cloud9'
      AND (COALESCE(p.slot_weekly,0) > 0 OR COALESCE(p.slot_monthly,0) > 0 OR COALESCE(p.slot,0) > 0)
    ORDER BY p.ram ASC, p.core ASC, p.price ASC, p.id ASC
  `);
}

async function listAllProducts() {
  await ensureCloud9Columns();
  return await db.all(`
    SELECT p.*, a.email, a.token
    FROM vps_products p
    LEFT JOIN do_api a ON a.id = p.api_id
    WHERE p.product_type = 'cloud9'
    ORDER BY p.status DESC, p.id DESC
  `);
}

async function getProduct(productId) {
  await ensureCloud9Columns();
  return await db.get(`
    SELECT p.*, a.email, a.token
    FROM vps_products p
    JOIN do_api a ON a.id = p.api_id
    WHERE p.id = ? AND p.product_type = 'cloud9'
  `, [productId]);
}

async function addProduct({ apiId, sizeSlug, ram, core, price = 170000, stock = 1, priceWeekly = 50000, stockWeekly = 0 }) {
  await ensureCloud9Columns();

  // Jangan lewat vpsManager.addCloud9Product agar tidak tergantung schema tambahan.
  const existing = await db.get(`
    SELECT id, slot, slot_weekly, slot_monthly
    FROM vps_products
    WHERE api_id = ? AND product_type = 'cloud9' AND size_slug = ? AND ram = ? AND core = ?
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
    VALUES (?, 'cloud9', ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, 1)
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
  await ensureCloud9Columns();

  // price = harga 30 hari. price_weekly = harga 7 hari.
  await db.run(
    'UPDATE vps_products SET price = ?, price_weekly = COALESCE(?, price_weekly) WHERE id = ? AND product_type = "cloud9"',
    [Number(priceMonthly), priceWeekly == null ? null : Number(priceWeekly), productId]
  );
}

async function decrementStock(productId, durationDays = 30) {
  await ensureCloud9Columns();
  const col = Number(durationDays) === 7 ? 'slot_weekly' : 'slot_monthly';
  await db.run(`
    UPDATE vps_products
    SET ${col} = CASE WHEN COALESCE(${col},0) > 0 THEN ${col} - 1 ELSE 0 END,
        slot = CASE WHEN COALESCE(slot,0) > 0 THEN slot - 1 ELSE 0 END
    WHERE id = ? AND product_type = 'cloud9'
  `, [productId]);
}

async function incrementStock(productId, durationDays = 30) {
  await ensureCloud9Columns();
  const col = Number(durationDays) === 7 ? 'slot_weekly' : 'slot_monthly';
  await db.run(`
    UPDATE vps_products
    SET ${col} = COALESCE(${col},0) + 1,
        slot = COALESCE(slot,0) + 1
    WHERE id = ? AND product_type = 'cloud9'
  `, [productId]);
}

async function deleteProduct(productId) {
  await ensureCloud9Columns();

  // Jangan DELETE fisik karena vps_instances bisa masih punya product_id ke spesifikasi ini.
  // Kalau dihapus fisik, SQLite bisa error: FOREIGN KEY constraint failed.
  // Cukup nonaktifkan spesifikasi agar tidak muncul di order, history Cloud9 tetap aman.
  await db.run(`
    UPDATE vps_products
    SET status = 0,
        slot = 0,
        slot_weekly = 0,
        slot_monthly = 0
    WHERE id = ? AND product_type = 'cloud9'
  `, [productId]);
}

async function listActiveCloud9Instances() {
  return await db.all(`
    SELECT *
    FROM vps_instances
    WHERE deleted_at IS NULL AND image LIKE 'cloud9:%'
    ORDER BY expires_at ASC, id DESC
  `);
}

async function listExpiredCloud9Instances(limit = 20) {
  const now = Math.floor(Date.now() / 1000);
  return await db.all(`
    SELECT *
    FROM vps_instances
    WHERE deleted_at IS NULL
      AND status = 1
      AND image LIKE 'cloud9:%'
      AND expires_at IS NOT NULL
      AND expires_at > 0
      AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT ?
  `, [now, Number(limit) || 20]);
}

async function markCloud9Deleted(instanceId) {
  const now = Math.floor(Date.now() / 1000);
  return await db.run(
    'UPDATE vps_instances SET status = 0, deleted_at = ? WHERE id = ? AND image LIKE "cloud9:%"',
    [now, instanceId]
  );
}


async function getCloud9Instance(instanceId) {
  return await db.get('SELECT * FROM vps_instances WHERE id = ? AND image LIKE "cloud9:%"', [instanceId]);
}

module.exports = {
  formatRp,
  formatDateShort,
  ensureCloud9Columns,
  listAwsApis,
  listActiveProducts,
  listAllProducts,
  getProduct,
  addProduct,
  updateProductPrice,
  decrementStock,
  incrementStock,
  deleteProduct,
  listActiveCloud9Instances,
  listExpiredCloud9Instances,
  markCloud9Deleted,
  getCloud9Instance
};
