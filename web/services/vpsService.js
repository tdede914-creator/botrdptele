/**
 * Order VPS (auto-create VPS biasa, tanpa install RDP/panel). Reuse logika bot
 * (vpsOrderHandler.createVps) tanpa objek Telegram. Harga/stok dari vps_products.
 */
const vpsManager = require('../../src/utils/vpsManager');
const { getRegions, getImages, createDroplet, waitPublicIp, deleteDroplet, isAwsToken, isLinodeToken, isUpCloudToken } = require('../../src/utils/doApi');
const rdp = require('./rdpService');
const { newJob, setJob, genAlphaNum, rootCloudInit, normalizeAwsRdpSize, waitForPort } = rdp._shared;

let upcloudApi = null;
try { upcloudApi = require('../../src/utils/upcloudApi'); } catch (_) { upcloudApi = null; }

async function listProducts() {
  const groups = await vpsManager.listActiveProductGroups('vps');
  return groups.map((g) => ({
    ram: Number(g.ram), core: Number(g.core),
    price_daily: g.price_daily != null ? Number(g.price_daily) : null,
    price_weekly: g.price_weekly != null ? Number(g.price_weekly) : null,
    price_monthly: g.price_monthly != null ? Number(g.price_monthly) : null,
    slot_daily: Number(g.slot_daily || 0), slot_weekly: Number(g.slot_weekly || 0), slot_monthly: Number(g.slot_monthly || 0)
  }));
}

async function getOrderOptions(ram, core, durationDays) {
  const prod = await vpsManager.getAvailableProductBySpecDuration('vps', Number(ram), Number(core), Number(durationDays));
  if (!prod) return { ok: false, error: 'Paket/slot untuk durasi ini tidak tersedia.' };
  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) return { ok: false, error: 'API cloud tidak ditemukan / nonaktif.' };
  let regions = []; let images = [];
  try { regions = await getRegions(token); } catch (_) {}
  try { images = await getImages(token); } catch (_) {}
  const d = Number(durationDays);
  const price = (d === 1) ? Number(prod.price_daily) : (d === 7 ? Number(prod.price_weekly) : Number(prod.price));
  return {
    ok: true, productId: prod.id, price,
    regions: (regions || []).slice(0, 60).map((r) => ({ slug: r.slug, name: r.name })),
    images: (images || []).slice(0, 40).map((i) => ({ slug: i.slug, label: i.label || i.slug }))
  };
}

// Reuse penghitung harga & reservasi slot dari rdpService (tabel vps_products sama).
async function prepareOrder(params) {
  const amt = await rdp.getOrderAmount(params.productId, params.durationDays);
  if (!amt.ok) return amt;
  return {
    ok: true, amount: amt.amount,
    reserve: () => rdp.reserveOrderSlot(params.productId, params.durationDays),
    release: () => rdp.releaseOrderSlot(params.productId, params.durationDays),
    provision: (uid, opts) => provisionVps(uid, params, opts)
  };
}

async function provisionVps(uid, { productId, regionSlug, imageSlug, durationDays }, opts = {}) {
  uid = String(uid || 0);
  const d = Number(durationDays);
  const prod = await vpsManager.getProduct(productId);
  if (!prod) { await rdp.releaseOrderSlot(productId, d); return { ok: false, error: 'Produk tidak ditemukan.' }; }
  const token = await vpsManager.getDoApiToken(prod.api_id);
  if (!token) { await rdp.releaseOrderSlot(productId, d); return { ok: false, error: 'API cloud tidak ditemukan.' }; }

  const rootPass = genAlphaNum(12);
  const cloudInit = rootCloudInit(rootPass);
  const hostname = `vps-${uid}-${genAlphaNum(6).toLowerCase()}`;
  const image = imageSlug || (isAwsToken(token) ? 'aws:ubuntu22.04' : (isLinodeToken(token) ? 'linode/ubuntu22.04' : (isUpCloudToken(token) ? 'upcloud/ubuntu22.04' : 'ubuntu-22-04-x64')));
  const refund = (opts.refund && opts.refund.uid) ? opts.refund : null;

  const jobId = newJob(uid, 'vps');
  setJob(jobId, { status: 'provisioning', step: 'create_vps', message: 'Membuat VPS...', progress: 15 });

  (async () => {
    let dropletId = null;
    try {
      const size = isAwsToken(token) ? normalizeAwsRdpSize(prod.size_slug) : prod.size_slug;
      const created = await createDroplet(token, hostname, regionSlug, size, image, cloudInit);
      dropletId = created.dropletId;
      if (!dropletId) {
        await rdp.releaseOrderSlot(productId, d);
        if (refund) { try { await require('../../src/utils/userManager').addBalance(refund.uid, refund.amount); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'create_vps', message: 'Gagal membuat VPS: ' + (created.error || 'unknown') });
        return;
      }
      setJob(jobId, { step: 'wait_ip', message: 'Menunggu IP publik...', progress: 45 });
      const ip = await waitPublicIp(token, dropletId, 40, 10000, regionSlug);
      if (!ip) {
        try { await deleteDroplet(token, dropletId, regionSlug); } catch (_) {}
        await rdp.releaseOrderSlot(productId, d);
        if (refund) { try { await require('../../src/utils/userManager').addBalance(refund.uid, refund.amount); } catch (_) {} }
        setJob(jobId, { status: 'failed', step: 'wait_ip', message: 'IP VPS belum tersedia. Coba region lain.' });
        return;
      }
      // UpCloud: aktifkan login root+password (template UpCloud key-only).
      if (isUpCloudToken(token) && created.sshPrivateKey && upcloudApi && typeof upcloudApi.upcloudProvisionRootPassword === 'function') {
        setJob(jobId, { step: 'config', message: 'Menyiapkan akses root...', progress: 65 });
        try { await upcloudApi.upcloudProvisionRootPassword(ip, created.sshPrivateKey, rootPass, { maxWaitMs: 6 * 60 * 1000 }); } catch (e) { console.warn('[web vps] upcloud root pass:', e.message || e); }
      }
      const nowSec = Math.floor(Date.now() / 1000);
      try { await require('../../src/utils/userManager').getUser(uid); } catch (_) {} // pastikan baris users ada (FK), termasuk tamu (uid 0)
      await vpsManager.createVpsInstance({ userId: uid, apiId: prod.api_id, productId: prod.id, dropletId, ip, region: regionSlug, image, rootPassword: rootPass, expiresAt: nowSec + d * 86400, durationDays: d });
      setJob(jobId, { step: 'wait_ssh', message: 'Menunggu VPS siap (SSH)...', progress: 80 });
      await waitForPort(ip, 22, 8 * 60 * 1000, 12000);
      setJob(jobId, { status: 'ready', step: 'done', message: 'VPS siap digunakan!', progress: 100, server: { ip, port: 22, username: 'root', password: rootPass, os: image, region: regionSlug } });
    } catch (e) {
      console.error('[web] provisionVps error:', e);
      setJob(jobId, { status: 'failed', step: 'error', message: 'Terjadi kesalahan: ' + (e.message || e) });
    }
  })();

  return { ok: true, jobId };
}

module.exports = { listProducts, getOrderOptions, prepareOrder };
