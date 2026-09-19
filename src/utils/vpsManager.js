const db = require('../config/database');
const { getAccountEmail, isLinodeToken, isAwsToken, isUpCloudToken, makeAwsToken, providerName } = require('./doApi');

async function addDoApiToken(token) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('EMPTY_TOKEN');

  // Prevent duplicate tokens
  const existing = await db.get('SELECT id, email, status FROM do_api WHERE token = ? LIMIT 1', [cleanToken]);
  if (existing && existing.id) {
    // If it was previously disabled, re-enable it when admin re-adds the same token.
    if (Number(existing.status) === 0) {
      await db.run('UPDATE do_api SET status = 1 WHERE id = ?', [existing.id]);
      return { exists: true, reenabled: true, apiId: existing.id, email: existing.email || null };
    }
    return { exists: true, reenabled: false, apiId: existing.id, email: existing.email || null };
  }

  // Resolve email from token so admin can identify which DO account each API belongs to.
  let email = null;
  try {
    email = await getAccountEmail(cleanToken);
  } catch (e) {
    // Keep email null if API call fails; we'll still store token.
    email = null;
  }

  const ins = await db.run('INSERT INTO do_api (token, email, status) VALUES (?, ?, 1)', [cleanToken, email]);
  return { exists: false, apiId: ins?.id || null, email };
}


async function addLinodeApiToken(token) {
  const raw = String(token || '').trim();
  if (!raw) throw new Error('EMPTY_TOKEN');
  const cleanToken = raw.startsWith('linode:') ? raw : `linode:${raw}`;

  const existing = await db.get('SELECT id, email, status FROM do_api WHERE token = ? LIMIT 1', [cleanToken]);
  if (existing && existing.id) {
    if (Number(existing.status) === 0) {
      await db.run('UPDATE do_api SET status = 1 WHERE id = ?', [existing.id]);
      return { exists: true, reenabled: true, apiId: existing.id, email: existing.email || null, provider: 'Linode' };
    }
    return { exists: true, reenabled: false, apiId: existing.id, email: existing.email || null, provider: 'Linode' };
  }

  let email = null;
  try { email = await getAccountEmail(cleanToken); } catch (_) { email = null; }
  const ins = await db.run('INSERT INTO do_api (token, email, status) VALUES (?, ?, 1)', [cleanToken, email]);
  return { exists: false, apiId: ins?.id || null, email, provider: 'Linode' };
}


async function addAwsApiToken(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('EMPTY_TOKEN');
  let accessKeyId, secretAccessKey, region;
  if (raw.startsWith('aws:')) {
    const parsed = require('./doApi').parseAwsToken(raw);
    accessKeyId = parsed.accessKeyId; secretAccessKey = parsed.secretAccessKey; region = parsed.region;
  } else {
    const parts = raw.split('|').map(x => x.trim()).filter(Boolean);
    if (parts.length < 2) throw new Error('Format AWS: ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION');
    accessKeyId = parts[0]; secretAccessKey = parts[1]; region = parts[2] || 'us-east-1';
  }
  const cleanToken = makeAwsToken(accessKeyId, secretAccessKey, region);
  const existing = await db.get('SELECT id, email, status FROM do_api WHERE token = ? LIMIT 1', [cleanToken]);
  if (existing && existing.id) {
    if (Number(existing.status) === 0) {
      await db.run('UPDATE do_api SET status = 1 WHERE id = ?', [existing.id]);
      return { exists: true, reenabled: true, apiId: existing.id, email: existing.email || null, provider: 'AWS' };
    }
    return { exists: true, reenabled: false, apiId: existing.id, email: existing.email || null, provider: 'AWS' };
  }
  let email = null;
  try { email = await getAccountEmail(cleanToken); } catch (_) { email = null; }
  if (!email) email = `AWS ${String(accessKeyId).slice(-6)} • ${region}`;
  const ins = await db.run('INSERT INTO do_api (token, email, status) VALUES (?, ?, 1)', [cleanToken, email]);
  return { exists: false, apiId: ins?.id || null, email, provider: 'AWS' };
}

function getApiProvider(apiRow) {
  if (isAwsToken(apiRow?.token)) return 'AWS';
  if (isLinodeToken(apiRow?.token)) return 'Linode';
  if (isUpCloudToken(apiRow?.token)) return 'UpCloud';
  return 'DigitalOcean';
}

/**
 * Tambah API UpCloud (bearer token format `ucat_xxxx`). Mirror pola AWS/Linode:
 * validasi format, cek duplikat, ambil account label untuk display,
 * simpan ke tabel `do_api` (shared table untuk semua provider).
 */
async function addUpCloudApiToken(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('EMPTY_TOKEN');
  if (!isUpCloudToken(raw)) {
    throw new Error('Format token UpCloud tidak valid. Harus diawali `ucat_` (buat di https://hub.upcloud.com/account/api-tokens).');
  }
  const cleanToken = raw;
  const existing = await db.get('SELECT id, email, status FROM do_api WHERE token = ? LIMIT 1', [cleanToken]);
  if (existing && existing.id) {
    if (Number(existing.status) === 0) {
      await db.run('UPDATE do_api SET status = 1 WHERE id = ?', [existing.id]);
      return { exists: true, reenabled: true, apiId: existing.id, email: existing.email || null, provider: 'UpCloud' };
    }
    return { exists: true, reenabled: false, apiId: existing.id, email: existing.email || null, provider: 'UpCloud' };
  }
  // Coba ambil label akun (username / credits) via /1.3/account
  let email = null;
  try {
    const { upcloudProbeAuth } = require('./upcloudApi');
    const probe = await upcloudProbeAuth(cleanToken);
    if (probe && probe.ok) {
      email = probe.email + (probe.credits != null ? ` • credits ${probe.credits}` : '');
    }
  } catch (_) { /* ignore, tetap simpan */ }
  if (!email) email = `UpCloud ${cleanToken.slice(5, 13)}...`; // fallback: prefix token
  const ins = await db.run('INSERT INTO do_api (token, email, status) VALUES (?, ?, 1)', [cleanToken, email]);
  return { exists: false, apiId: ins?.id || null, email, provider: 'UpCloud' };
}

function formatApiLabel(apiRow) {
  const provider = getApiProvider(apiRow);
  let email = apiRow?.email || '';
  if (!email && isAwsToken(apiRow?.token)) {
    const parsed = require('./doApi').parseAwsToken(apiRow.token);
    email = `AWS ${String(parsed.accessKeyId || '').slice(-6)} • ${parsed.region || 'us-east-1'}`;
  }
  return `${provider} API#${apiRow?.id}${email ? ' • ' + email : ''}`;
}

async function listDoApis() {
  // Include token for internal best-effort email backfill.
  const rows = await db.all('SELECT id, token, email, status, created_at FROM do_api ORDER BY id DESC');

  // Backfill missing emails (older DBs) so admin menus can show: email - API#X
  for (const r of rows || []) {
    if (r && !r.email && r.token) {
      try {
        const email = await getAccountEmail(r.token);
        if (email) {
          await db.run('UPDATE do_api SET email = ? WHERE id = ?', [email, r.id]);
          r.email = email;
        }
      } catch (_) {
        // ignore
      }
    }
  }

  return rows;
}

async function listActiveDoApis() {
  // Only APIs with status=1 are considered active/usable.
  return await db.all('SELECT id, token, email, status, created_at FROM do_api WHERE status = 1 ORDER BY id DESC');
}


async function getDoApiById(apiId) {
  return await db.get('SELECT id, token, email, status, created_at FROM do_api WHERE id = ? LIMIT 1', [apiId]);
}

async function getDoApiEmail(apiId) {
  const row = await db.get('SELECT email FROM do_api WHERE id = ?', [apiId]);
  return row?.email || null;
}

async function getDoApiToken(apiId) {
  // Only return token for ACTIVE APIs (status=1). This prevents ordering from disabled accounts.
  const row = await db.get('SELECT token FROM do_api WHERE id = ? AND status = 1', [apiId]);
  return row?.token || null;
}

async function getDoApiTokenAny(apiId) {
  // Used for cleanup tasks (expiry auto-delete). Returns token even if API is disabled.
  const row = await db.get('SELECT token FROM do_api WHERE id = ?', [apiId]);
  return row?.token || null;
}


async function disableDoApi(apiId) {
  await db.run('UPDATE do_api SET status = 0 WHERE id = ?', [apiId]);
  // Disable products from this API so stock won't be sold from a disabled account
  await db.run('UPDATE vps_products SET status = 0, slot = 0, slot_daily = 0, slot_weekly = 0, slot_monthly = 0 WHERE api_id = ?', [apiId]);
  return { action: 'disabled' };
}

async function deleteDoApiPermanent(apiId) {
  // Permanent delete must remove dependent rows first (vps_instances has FK w/o cascade)
  await db.exec('BEGIN TRANSACTION');
  try {
    await db.run('DELETE FROM vps_instances WHERE api_id = ?', [apiId]);
    await db.run('DELETE FROM vps_products WHERE api_id = ?', [apiId]);
    await db.run('DELETE FROM do_api_health WHERE api_id = ?', [apiId]);
    await db.run('DELETE FROM do_api WHERE id = ?', [apiId]);
    await db.exec('COMMIT');
    return { action: 'deleted' };
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

// Backward-compat: deleteDoApi now means permanent delete.
async function deleteDoApi(apiId) {
  return await deleteDoApiPermanent(apiId);
}

async function addVpsProduct({ apiId, sizeSlug, ram, core, priceDaily = null, priceWeekly = null, priceMonthly = null, slotDaily = 0, slotWeekly = 0, slotMonthly = 0 }) {
  return await addProduct({ apiId, productType: 'vps', sizeSlug, ram, core, priceDaily, priceWeekly, priceMonthly, slotDaily, slotWeekly, slotMonthly });
}

async function addRdpProduct({ apiId, sizeSlug, ram, core, priceDaily = null, priceWeekly = null, priceMonthly = null, slotDaily = 0, slotWeekly = 0, slotMonthly = 0 }) {
  return await addProduct({ apiId, productType: 'rdp', sizeSlug, ram, core, priceDaily, priceWeekly, priceMonthly, slotDaily, slotWeekly, slotMonthly });
}

async function addCloud9Product({ apiId, sizeSlug, ram, core, priceWeekly = null, priceMonthly = 170000, slotWeekly = 0, slotMonthly = 1 }) {
  return await addProduct({ apiId, productType: 'cloud9', sizeSlug, ram, core, priceDaily: null, priceWeekly, priceMonthly, slotDaily: 0, slotWeekly, slotMonthly });
}

async function addComboProduct({ apiId, sizeSlug, ram, core, priceDaily = null, priceWeekly = null, priceMonthly = null, slotDaily = 0, slotWeekly = 0, slotMonthly = 0 }) {
  return await addProduct({ apiId, productType: 'combo', sizeSlug, ram, core, priceDaily, priceWeekly, priceMonthly, slotDaily, slotWeekly, slotMonthly });
}

/**
 * Detect whether an instance row represents an RDP (Windows) deploy rather than a raw VPS.
 * Post combo-migration `product_type` becomes 'combo' for both, so we cannot rely on it
 * alone. The reliable signal is the `image` column: RDP orders always store the image with
 * an `rdp:` prefix (see rdpOrderHandler.createVpsInstance image: `rdp:${selectedOS.version}`).
 * We keep `product_type === 'rdp'` as a fallback so pre-migration rows still work.
 */
function isRdpInstance(row) {
  if (!row) return false;
  const image = String(row.image || '').toLowerCase();
  if (image.startsWith('rdp:')) return true;
  const productType = String(row.product_type || '').toLowerCase();
  return productType === 'rdp';
}

/**
 * Return SQL fragment for filtering vps_products by product_type in a family-aware way.
 * - For 'vps'|'rdp'|'combo': match all three (they share stock now).
 * - For other types ('cloud9','fastpanel'): filter exactly (each panel has its own manager).
 * The returned params must be appended to the parameter array of the caller.
 */
function _productTypeFilter(productType, alias = 'p') {
  const t = String(productType || '').toLowerCase();
  if (t === 'vps' || t === 'rdp' || t === 'combo') {
    return { sql: `${alias}.product_type IN ('vps','rdp','combo')`, params: [] };
  }
  return { sql: `${alias}.product_type = ?`, params: [t] };
}

async function addProduct({ apiId, productType, sizeSlug, ram, core, priceDaily = null, priceWeekly = null, priceMonthly = null, slotDaily = 0, slotWeekly = 0, slotMonthly = 0 }) {
  // Legacy column `price` is BULANAN.
  const monthlyPrice = (priceMonthly != null) ? Number(priceMonthly) : null;
  const weeklyPrice = (priceWeekly != null) ? Number(priceWeekly) : null;
  const dailyPrice = (priceDaily != null) ? Number(priceDaily) : null;

  // If the same product (same API, type, size, and weekly price) already exists, we increase the slots
  // (weeklyPrice can be NULL; we still keep the old behavior so duplicates are less likely)
  const existing = await db.get(
    `SELECT id, slot FROM vps_products
     WHERE api_id = ? AND product_type = ? AND size_slug = ? AND price_weekly IS ?
     LIMIT 1`,
    [apiId, productType, sizeSlug, weeklyPrice]
  );

  if (existing && existing.id) {
    const newSlotDaily = Number(existing.slot_daily || 0) + Number(slotDaily || 0);
    const newSlotWeekly = Number(existing.slot_weekly || 0) + Number(slotWeekly || 0);
    const newSlotMonthly = Number(existing.slot_monthly || 0) + Number(slotMonthly || 0);
    const newTotal = newSlotDaily + newSlotWeekly + newSlotMonthly;
    await db.run(
      `UPDATE vps_products
       SET slot_daily = ?, slot_weekly = ?, slot_monthly = ?,
           slot = ?, ram = ?, core = ?,
           price_daily = ?, price_weekly = ?,
           price = COALESCE(?, price)
       WHERE id = ?`,
      [newSlotDaily, newSlotWeekly, newSlotMonthly, newTotal, ram, core, dailyPrice, weeklyPrice, monthlyPrice, existing.id]
    );
    return;
  }

  await db.run(
    `INSERT INTO vps_products (api_id, product_type, size_slug, ram, core, price, price_daily, price_weekly, slot, slot_daily, slot_weekly, slot_monthly, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      apiId,
      productType,
      sizeSlug,
      ram,
      core,
      monthlyPrice,
      dailyPrice,
      weeklyPrice,
      Number(slotDaily || 0) + Number(slotWeekly || 0) + Number(slotMonthly || 0),
      Number(slotDaily || 0),
      Number(slotWeekly || 0),
      Number(slotMonthly || 0)
    ]
  );
}

async function listActiveProducts(productType = 'vps') {
  const tf = _productTypeFilter(productType);
  return await db.all(
    `SELECT p.id, p.api_id, p.ram, p.core, p.price, p.slot, p.size_slug, p.product_type
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND p.slot > 0 AND ${tf.sql}
     ORDER BY p.price ASC`,
    tf.params
  );
}

// Aggregate products that share the same spec (ram/core/price) across different APIs.
// This is used to display a single menu entry with combined stock.
async function listActiveProductGroups(productType = 'vps') {
  const tf = _productTypeFilter(productType);
  return await db.all(
    `SELECT 
        p.ram, 
        p.core, 
        MIN(p.price_daily) as price_daily,
        MIN(p.price_weekly) as price_weekly,
        MIN(p.price) as price_monthly,
        COALESCE(SUM(p.slot_daily), 0) as slot_daily,
        COALESCE(SUM(p.slot_weekly), 0) as slot_weekly,
        COALESCE(SUM(p.slot_monthly), 0) as slot_monthly,
        COALESCE(SUM(p.slot), 0) as slot
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND p.slot > 0 AND ${tf.sql}
     GROUP BY p.ram, p.core
     ORDER BY COALESCE(MIN(p.price_weekly), MIN(p.price), 999999999) ASC, p.ram ASC, p.core ASC`,
    tf.params
  );
}



// List groups by duration (1=harian,7=mingguan,30=bulanan) for admin stock delete menu.
async function listActiveProductGroupsByDuration(productType = 'vps', durationDays = 30) {
  const priceCol = _priceColumnForDuration(durationDays);
  const slotCol = _slotColumnForDuration(durationDays);
  const tf = _productTypeFilter(productType);
  return await db.all(
    `SELECT 
        p.ram, 
        p.core, 
        MIN(p.${priceCol}) as price,
        COALESCE(SUM(p.${slotCol}), 0) as slot
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND ${tf.sql} AND COALESCE(p.${slotCol},0) > 0
     GROUP BY p.ram, p.core
     ORDER BY MIN(p.${priceCol}) ASC, p.ram ASC, p.core ASC`,
    tf.params
  );
}

async function listActiveProductsByGroupDuration(productType, ram, core, durationDays = 30) {
  const priceCol = _priceColumnForDuration(durationDays);
  const slotCol = _slotColumnForDuration(durationDays);
  const tf = _productTypeFilter(productType);
  return await db.all(
    `SELECT p.id, p.api_id, p.ram, p.core, p.${priceCol} as price, p.${slotCol} as slot, p.size_slug, a.email
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND ${tf.sql} AND p.ram = ? AND p.core = ? AND COALESCE(p.${slotCol},0) > 0
     ORDER BY COALESCE(p.${slotCol},0) DESC, p.id ASC`,
    [...tf.params, ram, core]
  );
}

async function getProduct(productId) {
  return await db.get(
    'SELECT id, api_id, ram, core, price, price_daily, price_weekly, slot, slot_daily, slot_weekly, slot_monthly, size_slug, product_type FROM vps_products WHERE id = ?',
    [productId]
  );
}

function _priceColumnForDuration(durationDays) {
  const d = Number(durationDays);
  if (d === 1) return 'price_daily';
  if (d === 7) return 'price_weekly';
  // Bulanan (30 hari) memakai kolom legacy `price` agar kompatibel dengan DB lama.
  return 'price';
}

function _slotColumnForDuration(durationDays) {
  const d = Number(durationDays);
  if (d === 1) return 'slot_daily';
  if (d === 7) return 'slot_weekly';
  return 'slot_monthly';
}

// Backward-compat helpers (old code/admin panel used a single `slot`).
// We map it to BULANAN (30 hari).
async function decrementProductSlot(productId) {
  return await decrementProductSlotDuration(productId, 30);
}

async function incrementProductSlot(productId) {
  return await incrementProductSlotDuration(productId, 30);
}

async function decrementProductSlotDuration(productId, durationDays) {
  const col = _slotColumnForDuration(durationDays);
  await db.exec('BEGIN TRANSACTION');
  try {
    // Use COALESCE to avoid NULL arithmetic that can cause stock counts to become NULL
    // (and menus then treat the product as out of stock).
    await db.run(
      `UPDATE vps_products SET ${col} = COALESCE(${col}, 0) - 1 WHERE id = ? AND COALESCE(${col}, 0) > 0`,
      [productId]
    );
    await db.run('UPDATE vps_products SET slot = COALESCE(slot_daily,0) + COALESCE(slot_weekly,0) + COALESCE(slot_monthly,0) WHERE id = ?', [productId]);
    await db.exec('COMMIT');
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

async function incrementProductSlotDuration(productId, durationDays) {
  const col = _slotColumnForDuration(durationDays);
  await db.exec('BEGIN TRANSACTION');
  try {
    await db.run(`UPDATE vps_products SET ${col} = COALESCE(${col}, 0) + 1 WHERE id = ?`, [productId]);
    await db.run('UPDATE vps_products SET slot = COALESCE(slot_daily,0) + COALESCE(slot_weekly,0) + COALESCE(slot_monthly,0) WHERE id = ?', [productId]);
    await db.exec('COMMIT');
  } catch (e) {
    try { await db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}


async function createVpsInstance({ userId, apiId, productId, dropletId, ip, region, image, rootPassword, expiresAt = null, durationDays = null, rdpPort = null }) {
  const res = await db.run(
    `INSERT INTO vps_instances (user_id, api_id, origin_api_id, product_id, droplet_id, ip, region, image, root_password, created_at, expires_at, duration_days, rdp_port, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [userId, apiId, apiId, productId, dropletId, ip, region, image, rootPassword, Math.floor(Date.now() / 1000), expiresAt, durationDays, rdpPort]
  );
  return res && res.id;
}

async function listUserVps(userId) {
  // Backward compatibility: returns both VPS and RDP instances (active)
  return await db.all(
    `SELECT vi.id, vi.droplet_id, vi.ip, vi.region, vi.image, vi.created_at, vi.rdp_port,
            vi.root_password, vi.expires_at, vi.duration_days,
            vp.product_type, vp.size_slug, vp.price
     FROM vps_instances vi
     LEFT JOIN vps_products vp ON vp.id = vi.product_id
     WHERE vi.user_id = ? AND vi.status = 1
     ORDER BY vi.id DESC`,
    [userId]
  );
}


async function listActiveVpsByApi(apiId) {
  return await db.all(
    `SELECT id, user_id, droplet_id, ip, region, image, created_at
     FROM vps_instances
     WHERE api_id = ? AND status = 1
     ORDER BY id DESC`,
    [apiId]
  );
}

async function listAllActiveInstances() {
  // Gabungkan data order normal + data renter hasil backup/restore + legacy RDP.
  // Data dikembalikan dengan info API dan buyer agar Admin > List VPS&RDP mudah disimpan.
  const normalRows = await db.all(
    `SELECT vi.id, vi.user_id,
            COALESCE(vi.api_id, vi.origin_api_id, vp.api_id) as api_id,
            vi.origin_api_id, vi.product_id, vi.droplet_id, vi.ip, vi.region, vi.image,
            vi.created_at, vi.expires_at, vi.duration_days, vi.rdp_port,
            vp.product_type, vp.size_slug, vp.ram, vp.core,
            a.email as api_email,
            rr.username as buyer_username,
            'admin' as api_scope,
            'order' as source
     FROM vps_instances vi
     LEFT JOIN vps_products vp ON vp.id = vi.product_id
     LEFT JOIN do_api a ON a.id = COALESCE(vi.api_id, vi.origin_api_id, vp.api_id)
     LEFT JOIN renters rr ON rr.user_id = vi.user_id
     WHERE vi.status IS NULL OR vi.status = 1 OR vi.status = '1' OR LOWER(CAST(vi.status AS TEXT)) = 'active'`
  );

  let renterRows = [];
  try {
    renterRows = await db.all(
      `SELECT ri.id, ri.user_id, ri.api_id, NULL as origin_api_id, NULL as product_id, ri.droplet_id, ri.ip, ri.region, ri.image,
              ri.created_at, r.expires_at as expires_at, NULL as duration_days, ri.rdp_port,
              ri.type as product_type, ri.size_slug, NULL as ram, NULL as core,
              ra.email as api_email,
              r.username as buyer_username,
              'renter' as api_scope,
              'renter' as source
       FROM renter_instances ri
       LEFT JOIN renters r ON r.user_id = ri.user_id
       LEFT JOIN renter_do_api ra ON ra.id = ri.api_id
       WHERE ri.status IS NULL OR ri.status = 1 OR ri.status = '1' OR LOWER(CAST(ri.status AS TEXT)) = 'active'`
    );
  } catch (_) {
    renterRows = [];
  }

  let legacyRdpRows = [];
  try {
    legacyRdpRows = await db.all(
      `SELECT id, user_id, NULL as api_id, NULL as origin_api_id, NULL as product_id, NULL as droplet_id,
              ip_address as ip, NULL as region, os_type as image,
              CAST(strftime('%s', created_at) AS INTEGER) as created_at, NULL as expires_at, NULL as duration_days,
              'rdp' as product_type, NULL as size_slug, NULL as ram, NULL as core,
              NULL as api_email,
              NULL as buyer_username,
              'legacy' as api_scope,
              'legacy_rdp' as source
       FROM rdp_installations
       WHERE status IS NULL OR LOWER(CAST(status AS TEXT)) NOT IN ('deleted','failed','0')`
    );
  } catch (_) {
    legacyRdpRows = [];
  }

  const rows = [...(normalRows || []), ...(renterRows || []), ...(legacyRdpRows || [])];
  rows.sort((a, b) => {
    const aa = Number(a.api_id || 0);
    const ba = Number(b.api_id || 0);
    if (aa !== ba) return aa - ba;
    const ae = Number(a.expires_at || 9999999999);
    const be = Number(b.expires_at || 9999999999);
    if (ae !== be) return ae - be;
    return Number(b.created_at || b.id || 0) - Number(a.created_at || a.id || 0);
  });
  return rows;
}

async function getVpsInstance(vpsId) {
  return await db.get(
    `SELECT vi.id, vi.user_id, vi.api_id, vi.origin_api_id, vi.product_id, vi.droplet_id, vi.ip, vi.region, vi.image,
            vi.root_password, vi.status, vi.expires_at, vi.duration_days, vi.rdp_port,
            vp.product_type, vp.size_slug, vp.ram, vp.core, vp.price, vp.price_daily, vp.price_weekly
     FROM vps_instances vi
     LEFT JOIN vps_products vp ON vp.id = vi.product_id
     WHERE vi.id = ?`,
    [vpsId]
  );
}


async function markVpsDeleted(vpsId) {
  await db.run('UPDATE vps_instances SET status = 0 WHERE id = ?', [vpsId]);
}

// Update port RDP untuk instance (dipakai saat rebuild kalau provider berubah
// atau instance lama belum punya nilai rdp_port).
async function updateVpsInstanceRdpPort(vpsId, port) {
  await db.run('UPDATE vps_instances SET rdp_port = ? WHERE id = ?', [Number(port) || null, vpsId]);
}

async function updateVpsInstancePassword(vpsId, newPassword) {
  await db.run(
    `UPDATE vps_instances SET root_password = ? WHERE id = ?`,
    [newPassword, vpsId]
  );
}

async function updateVpsInstanceImage(vpsId, image) {
  await db.run('UPDATE vps_instances SET image = ? WHERE id = ?', [image, vpsId]);
}

async function markVpsInstanceDeleted(vpsId) {
  await db.run(
    `UPDATE vps_instances SET status = 0 WHERE id = ?`,
    [vpsId]
  );
}

async function updateVpsInstanceDroplet(vpsId, dropletId, ip, region, image, rootPassword) {
  await db.run(
    `UPDATE vps_instances
     SET droplet_id = ?, ip = ?, region = ?, image = ?, root_password = ?, created_at = ?
     WHERE id = ?`,
    [dropletId, ip, region, image, rootPassword, Date.now(), vpsId]
  );
}


async function getAvailableProductBySpec(productType, ram, core, price) {
  // Legacy selector kept for backward compatibility
  const tf = _productTypeFilter(productType);
  return await db.get(
    `SELECT p.id, p.api_id, p.ram, p.core, p.price, p.price_daily, p.price_weekly, p.slot, p.size_slug, p.product_type
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND p.slot > 0 AND ${tf.sql} AND p.ram = ? AND p.core = ? AND p.price = ?
     ORDER BY p.slot DESC, p.id ASC
     LIMIT 1`,
    [...tf.params, ram, core, price]
  );
}

async function getAvailableProductBySpecDuration(productType, ram, core, durationDays) {
  const d = Number(durationDays);
  const priceCol = (d === 1) ? 'price_daily' : (d === 7 ? 'price_weekly' : 'price');
  const slotCol = (d === 1) ? 'slot_daily' : (d === 7 ? 'slot_weekly' : 'slot_monthly');
  const tf = _productTypeFilter(productType);
  return await db.get(
    `SELECT p.id, p.api_id, p.ram, p.core, p.price, p.price_daily, p.price_weekly, p.slot, p.slot_daily, p.slot_weekly, p.slot_monthly, p.size_slug, p.product_type
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 
       AND p.${slotCol} > 0
       AND ${tf.sql}
       AND p.ram = ? 
       AND p.core = ? 
       AND p.${priceCol} IS NOT NULL
     ORDER BY p.slot DESC, p.id ASC
     LIMIT 1`,
    [...tf.params, ram, core]
  );
}

async function getTotalSlotBySpec(productType, ram, core, price) {
  const tf = _productTypeFilter(productType);
  const row = await db.get(
    `SELECT COALESCE(SUM(p.slot), 0) as total_slot
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND p.slot > 0 AND ${tf.sql} AND p.ram = ? AND p.core = ? AND p.price = ?`,
    [...tf.params, ram, core, price]
  );
  return Number(row?.total_slot || 0);
}



async function listActiveProductsByGroup(productType, ram, core, price) {
  const tf = _productTypeFilter(productType);
  return await db.all(
    `SELECT p.id, p.api_id, p.ram, p.core, p.price, p.slot, p.size_slug, a.email
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND p.slot > 0 AND ${tf.sql} AND p.ram = ? AND p.core = ? AND p.price = ?
     ORDER BY p.slot DESC, p.id ASC`,
    [...tf.params, ram, core, price]
  );
}

// Summaries per spec (ram/core) regardless of API; shows price range if different.
async function listActiveSpecSummaries(productType = 'vps') {
  const tf = _productTypeFilter(productType);
  return await db.all(
    `SELECT p.ram, p.core,
            MIN(p.price_daily) as min_price_daily,
            MAX(p.price_daily) as max_price_daily,
            MIN(p.price_weekly) as min_price_weekly,
            MAX(p.price_weekly) as max_price_weekly,
            MIN(p.price) as min_price_monthly,
            MAX(p.price) as max_price_monthly,
            COALESCE(SUM(p.slot), 0) as slot,
            COALESCE(SUM(p.slot_daily), 0) as slot_daily,
            COALESCE(SUM(p.slot_weekly), 0) as slot_weekly,
            COALESCE(SUM(p.slot_monthly), 0) as slot_monthly
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND p.slot > 0 AND ${tf.sql}
     GROUP BY p.ram, p.core
     ORDER BY COALESCE(MIN(p.price_weekly), MIN(p.price), 999999999) ASC, p.ram ASC, p.core ASC`,
    tf.params
  );
}


async function getFallbackProductForInstance(vps) {
  if (!vps) return null;
  // Any legacy vps/rdp/combo now share stock; the family filter inside
  // getAvailableProductBySpecDuration handles this.
  let productType = vps.product_type;
  if (!productType) productType = String(vps.image || '').startsWith('rdp:') ? 'rdp' : 'vps';
  const ram = Number(vps.ram || 0);
  const core = Number(vps.core || 0);
  const durationDays = Number(vps.duration_days || 30);
  if (!ram || !core) return null;
  return await getAvailableProductBySpecDuration(productType, ram, core, durationDays);
}

async function updateVpsInstanceApiProduct(vpsId, apiId, productId) {
  await db.run('UPDATE vps_instances SET api_id = ?, origin_api_id = ?, product_id = ? WHERE id = ?', [apiId, apiId, productId, vpsId]);
}

async function getProductAny(productId) {
  if (!productId) return null;
  return await db.get(
    'SELECT id, api_id, ram, core, price, price_daily, price_weekly, slot, slot_daily, slot_weekly, slot_monthly, size_slug, product_type, status FROM vps_products WHERE id = ?',
    [productId]
  );
}

async function getFallbackProductForInstancePrefer(vps, excludeApiId = null) {
  if (!vps) return null;
  const productType = vps.product_type || (String(vps.image || '').startsWith('rdp:') ? 'rdp' : 'vps');
  const ram = Number(vps.ram || 0);
  const core = Number(vps.core || 0);
  const durationDays = Number(vps.duration_days || 30);
  if (!ram || !core) return null;
  const d = Number(durationDays);
  const priceCol = (d === 1) ? 'price_daily' : (d === 7 ? 'price_weekly' : 'price');
  const slotCol = (d === 1) ? 'slot_daily' : (d === 7 ? 'slot_weekly' : 'slot_monthly');
  const tf = _productTypeFilter(productType);
  const params = [...tf.params, ram, core];
  let notApi = '';
  if (excludeApiId) { notApi = ' AND p.api_id != ? '; params.push(Number(excludeApiId)); }
  return await db.get(
    `SELECT p.id, p.api_id, p.ram, p.core, p.price, p.price_daily, p.price_weekly, p.slot, p.slot_daily, p.slot_weekly, p.slot_monthly, p.size_slug, p.product_type
     FROM vps_products p
     JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1
       AND COALESCE(p.${slotCol},0) > 0
       AND ${tf.sql}
       AND p.ram = ?
       AND p.core = ?
       AND p.${priceCol} IS NOT NULL
       ${notApi}
     ORDER BY p.id ASC
     LIMIT 1`,
    params
  );
}

// Update price for all APIs with same spec (ram/core) and consolidate duplicates after update.
// For VPS/RDP family (vps/rdp/combo), the same price applies to all family rows sharing
// the same (ram, core) so the shared-stock UX works transparently.
async function updatePriceBySpec(productType, ram, core, priceDaily, priceWeekly, priceMonthly, provider = 'all') {
  const tf = _productTypeFilter(productType, 'vps_products');
  await db.run(
    `UPDATE vps_products
     SET price_daily = ?, price_weekly = ?, price = COALESCE(?, price)
     WHERE status = 1
       AND ${tf.sql}
       AND ram = ?
       AND core = ?
       AND api_id IN (SELECT id FROM do_api WHERE status = 1 ${_providerCondition(provider, 'do_api')})`,
    [priceDaily, priceWeekly, priceMonthly, ...tf.params, ram, core]
  );
}


async function getAdminPowerTarget(source, id) {
  const src = String(source || 'normal');
  if (src === 'renter') {
    const row = await db.get(
      `SELECT ri.id, ri.user_id, ri.api_id, ri.droplet_id, ri.ip, ri.type as product_type, ri.size_slug, ri.region,
              ra.token, ra.email
       FROM renter_instances ri
       LEFT JOIN renter_do_api ra ON ra.id = ri.api_id
       WHERE ri.id = ? LIMIT 1`,
      [id]
    );
    if (!row || !row.droplet_id) return null;
    return row;
  }

  // TURN ON/OFF wajib memakai API asal VPS/RDP tersebut. Tidak fallback ke API lain.
  const row = await db.get(
    `SELECT vi.id, vi.user_id,
            COALESCE(vi.api_id, vi.origin_api_id, vp.api_id) as api_id,
            vi.droplet_id, vi.ip, vi.region, vi.image,
            COALESCE(vp.product_type, CASE WHEN vi.image LIKE 'rdp:%' THEN 'rdp' ELSE 'vps' END) as product_type,
            vp.size_slug, da.token, da.email
     FROM vps_instances vi
     LEFT JOIN vps_products vp ON vp.id = vi.product_id
     LEFT JOIN do_api da ON da.id = COALESCE(vi.api_id, vi.origin_api_id, vp.api_id)
     WHERE vi.id = ? LIMIT 1`,
    [id]
  );
  if (!row || !row.droplet_id) return null;
  return row;
}


function _providerCondition(provider, alias = 'a') {
  const p = String(provider || 'all').toLowerCase();
  if (p === 'do' || p === 'digitalocean') return ` AND ${alias}.token NOT LIKE 'linode:%' AND ${alias}.token NOT LIKE 'aws:%' AND ${alias}.token NOT LIKE 'ucat_%' `;
  if (p === 'linode') return ` AND ${alias}.token LIKE 'linode:%' `;
  if (p === 'aws') return ` AND ${alias}.token LIKE 'aws:%' `;
  if (p === 'upcloud') return ` AND ${alias}.token LIKE 'ucat_%' `;
  return '';
}
async function listApisByProvider(provider = 'all') {
  const rows = await listDoApis();
  const p = String(provider || 'all').toLowerCase();
  if (p === 'all') return rows;
  return rows.filter(r => getApiProvider(r).toLowerCase() === (p === 'do' ? 'digitalocean' : p));
}
async function listActiveProductProviders(productType, ram, core, durationDays = 30) {
  const d = Number(durationDays); const slotCol = _slotColumnForDuration(d); const priceCol = _priceColumnForDuration(d);
  const tf = _productTypeFilter(productType);
  return await db.all(
    `SELECT CASE WHEN a.token LIKE 'linode:%' THEN 'linode' WHEN a.token LIKE 'aws:%' THEN 'aws' WHEN a.token LIKE 'ucat_%' THEN 'upcloud' ELSE 'digitalocean' END as provider,
            COUNT(*) as api_count, COALESCE(SUM(p.${slotCol}),0) as slot, MIN(p.${priceCol}) as price
     FROM vps_products p JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND ${tf.sql} AND p.ram = ? AND p.core = ? AND COALESCE(p.${slotCol},0) > 0 AND p.${priceCol} IS NOT NULL
     GROUP BY provider ORDER BY provider ASC`, [...tf.params, ram, core]);
}
async function getAvailableProductBySpecDurationProvider(productType, ram, core, durationDays = 30, provider = 'all') {
  const d = Number(durationDays); const priceCol = _priceColumnForDuration(d); const slotCol = _slotColumnForDuration(d);
  const tf = _productTypeFilter(productType);
  return await db.get(
    `SELECT p.id, p.api_id, p.ram, p.core, p.price, p.price_daily, p.price_weekly, p.slot, p.slot_daily, p.slot_weekly, p.slot_monthly, p.size_slug, p.product_type
     FROM vps_products p JOIN do_api a ON a.id = p.api_id AND a.status = 1
     WHERE p.status = 1 AND COALESCE(p.${slotCol},0) > 0 AND ${tf.sql} AND p.ram = ? AND p.core = ? AND p.${priceCol} IS NOT NULL ${_providerCondition(provider, 'a')}
     ORDER BY COALESCE(p.${slotCol},0) DESC, p.id ASC LIMIT 1`, [...tf.params, ram, core]);
}

module.exports = {
  addDoApiToken,
  addLinodeApiToken,
  addAwsApiToken,
  addUpCloudApiToken,
  getApiProvider,
  listApisByProvider,
  listActiveProductProviders,
  getAvailableProductBySpecDurationProvider,
  formatApiLabel,
  listDoApis,
  listActiveDoApis,
  getDoApiById,
  getDoApiToken,
  getDoApiEmail,
  disableDoApi,
  deleteDoApiPermanent,
  deleteDoApi,
  addVpsProduct,
  addRdpProduct,
  addCloud9Product,
  addComboProduct,
  isRdpInstance,
  listActiveProducts,
  listActiveProductGroups,
  listActiveProductGroupsByDuration,
  listActiveProductsByGroupDuration,
  getProduct,
  decrementProductSlot,
  incrementProductSlot,
  decrementProductSlotDuration,
  incrementProductSlotDuration,
  createVpsInstance,
  updateVpsInstanceRdpPort,
  listUserVps,
  listActiveVpsByApi,
  listAllActiveInstances,
  getVpsInstance,
  updateVpsInstancePassword,
  updateVpsInstanceImage,
  markVpsInstanceDeleted,
  updateVpsInstanceDroplet,
  // Backward-compat aliases
  markVpsDeleted: markVpsInstanceDeleted,
  getAvailableProductBySpec,
  getAvailableProductBySpecDuration,
  getTotalSlotBySpec,
  listActiveProductsByGroup,
  listActiveSpecSummaries,
  updatePriceBySpec,
  getDoApiTokenAny,
  getFallbackProductForInstance,
  updateVpsInstanceApiProduct,
  getProductAny,
  getFallbackProductForInstancePrefer,
  getAdminPowerTarget,
};
