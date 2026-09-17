/**
 * Kelola VPS/RDP milik user (khusus pemilik): list, power ON/OFF, hapus.
 * (Rebuild ditambahkan menyusul.)
 */
const vpsManager = require('../../src/utils/vpsManager');
const { powerDroplet, deleteDroplet } = require('../../src/utils/doApi');

function typeOf(image) {
  const s = String(image || '').toLowerCase();
  if (s.startsWith('rdp:')) return 'RDP';
  if (s.startsWith('cloud9:')) return 'Cloud9';
  if (s.startsWith('fastpanel:')) return 'Fastpanel';
  return 'VPS';
}
function osLabel(image) {
  return String(image || '').replace(/^(rdp|cloud9|fastpanel):/, '') || '-';
}

// Daftar server milik user (aktif).
async function listServers(userId) {
  let rows = [];
  try { rows = await vpsManager.listUserVps(userId); } catch (_) { rows = []; }
  return (rows || []).map((r) => {
    const type = typeOf(r.image);
    const port = r.rdp_port || (type === 'RDP' ? 4443 : 22);
    return {
      id: r.id,
      type,
      ip: r.ip || null,
      server: r.ip ? `${r.ip}:${port}` : '-',
      port,
      region: r.region || '-',
      os: osLabel(r.image),
      size: r.size_slug || '-',
      createdAt: r.created_at || null,
      hasDroplet: !!r.droplet_id
    };
  });
}

// Ambil instance milik user (validasi kepemilikan).
async function _ownedInstance(userId, id) {
  const inst = await vpsManager.getVpsInstance(Number(id));
  if (!inst) return { error: 'Server tidak ditemukan.' };
  if (String(inst.user_id) !== String(userId)) return { error: 'Ini bukan server kamu.' };
  return { inst };
}

async function powerServer(userId, id, action) {
  const act = action === 'on' ? 'on' : 'off';
  const { inst, error } = await _ownedInstance(userId, id);
  if (error) return { ok: false, error };
  if (!inst.droplet_id) return { ok: false, error: 'Server ini tidak punya droplet ID.' };
  const apiId = inst.api_id || inst.origin_api_id;
  const token = await vpsManager.getDoApiTokenAny(apiId);
  if (!token) return { ok: false, error: 'API/akun cloud server ini tidak ditemukan.' };
  const res = await powerDroplet(token, inst.droplet_id, act, inst.region);
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'Gagal mengubah power.' };
  return { ok: true, action: act };
}

async function deleteServer(userId, id) {
  const { inst, error } = await _ownedInstance(userId, id);
  if (error) return { ok: false, error };
  const apiId = inst.api_id || inst.origin_api_id;
  const token = await vpsManager.getDoApiTokenAny(apiId);
  if (inst.droplet_id && token) {
    try { await deleteDroplet(token, inst.droplet_id, inst.region); } catch (_) {}
  }
  try { await vpsManager.markVpsDeleted(inst.id); } catch (_) {}
  // Kembalikan slot stok bila instance berasal dari produk berdurasi.
  if (inst.product_id && inst.duration_days) {
    try { await vpsManager.incrementProductSlotDuration(inst.product_id, Number(inst.duration_days)); } catch (_) {}
  }
  return { ok: true };
}

module.exports = { listServers, powerServer, deleteServer };
