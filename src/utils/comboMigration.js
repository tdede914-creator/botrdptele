const db = require('../config/database');
const adminSettings = require('./adminSettings');

/**
 * Combo migration:
 *   - Group legacy vps_products rows with product_type IN ('vps','rdp') by (api_id, size_slug)
 *   - If only 1 row in group  -> promote to product_type='combo'
 *   - If multiple rows (VPS and RDP for same spec) -> merge into one 'combo' row:
 *       * Prefer the RDP row as primary (per admin preference: RDP price dominates)
 *       * Sum slot_daily / slot_weekly / slot_monthly across all rows
 *       * Deactivate other rows (soft delete: status=0, slots=0) so FK to vps_instances stays valid
 *   - Idempotent: gated by admin_setting `combo_migration_done`.
 */
async function runComboMigration() {
  try {
    const done = await adminSettings.getNumber('combo_migration_done', 0);
    if (Number(done) === 1) return { skipped: true };
  } catch (_) {
    // Settings table might not exist yet on very old DBs; proceed anyway.
  }

  let legacy = [];
  try {
    legacy = await db.all(`
      SELECT id, api_id, product_type, size_slug, ram, core,
             price, price_daily, price_weekly,
             slot, slot_daily, slot_weekly, slot_monthly, status
      FROM vps_products
      WHERE product_type IN ('vps', 'rdp')
      ORDER BY api_id ASC, size_slug ASC, product_type ASC, id ASC
    `);
  } catch (e) {
    console.error('Combo migration: cannot read vps_products:', e.message || e);
    return { error: e.message || String(e) };
  }

  if (!Array.isArray(legacy) || legacy.length === 0) {
    try { await adminSettings.setSetting('combo_migration_done', 1); } catch (_) {}
    return { converted: 0, merged: 0, skipped: false };
  }

  // Group by (api_id, size_slug)
  const groups = new Map();
  for (const row of legacy) {
    const key = `${row.api_id}|${String(row.size_slug || '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let converted = 0;
  let merged = 0;
  let deactivated = 0;

  for (const [, rows] of groups) {
    if (rows.length === 1) {
      // Single legacy row -> promote to combo directly.
      try {
        await db.run('UPDATE vps_products SET product_type = ? WHERE id = ?', ['combo', rows[0].id]);
        converted++;
      } catch (e) {
        console.error(`Combo migration: promote fail id=${rows[0].id}:`, e.message || e);
      }
      continue;
    }

    // Multiple rows for same (api_id, size_slug) - merge.
    // Pick RDP as primary (admin preference: harga VPS ikut RDP).
    let primary = rows.find(r => String(r.product_type).toLowerCase() === 'rdp');
    if (!primary) primary = rows[0];
    const secondaries = rows.filter(r => r.id !== primary.id);

    const sumBy = (col) => rows.reduce((s, r) => s + Number(r[col] || 0), 0);
    const totalSlotDaily = sumBy('slot_daily');
    const totalSlotWeekly = sumBy('slot_weekly');
    const totalSlotMonthly = sumBy('slot_monthly');
    const totalSlot = totalSlotDaily + totalSlotWeekly + totalSlotMonthly;

    try {
      await db.run(`
        UPDATE vps_products
        SET product_type = 'combo',
            slot         = ?,
            slot_daily   = ?,
            slot_weekly  = ?,
            slot_monthly = ?,
            status       = 1
        WHERE id = ?
      `, [totalSlot, totalSlotDaily, totalSlotWeekly, totalSlotMonthly, primary.id]);

      for (const s of secondaries) {
        await db.run(`
          UPDATE vps_products
          SET status = 0,
              slot = 0,
              slot_daily = 0,
              slot_weekly = 0,
              slot_monthly = 0
          WHERE id = ?
        `, [s.id]);
        deactivated++;
      }
      merged++;
    } catch (e) {
      console.error(`Combo migration: merge fail api_id=${primary.api_id} size=${primary.size_slug}:`, e.message || e);
    }
  }

  try {
    await adminSettings.setSetting('combo_migration_done', 1);
  } catch (e) {
    console.error('Combo migration: could not set combo_migration_done flag:', e.message || e);
  }

  console.log(`✅ Combo migration: converted=${converted}, merged=${merged}, deactivated=${deactivated}`);
  return { converted, merged, deactivated, skipped: false };
}

module.exports = { runComboMigration };
