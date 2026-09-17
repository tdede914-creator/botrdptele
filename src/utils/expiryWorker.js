const db = require('../config/database');
const vpsManager = require('./vpsManager');
const { deleteDroplet } = require('./doApi');

/**
 * Start a simple expiry worker:
 * - Remind H-1 (<=24h) once per 6 hours
 * - Auto delete when expired
 *
 * Note: best-effort. If DO delete fails, we still mark as deleted to prevent loops.
 */
function startExpiryWorker(bot, opts = {}) {
  const intervalMs = Number(opts.intervalMs || 10 * 60 * 1000); // 10 minutes
  const remindWindowSec = Number(opts.remindWindowSec || 24 * 3600);
  const remindCooldownSec = Number(opts.remindCooldownSec || 6 * 3600);

  const tick = async () => {
    const now = Math.floor(Date.now() / 1000);

    // 1) Reminder (H-1)
    try {
      const expiring = await db.all(
        `SELECT id, user_id, ip, expires_at, last_notified_at
         FROM vps_instances
         WHERE status = 1 AND expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?`,
        [now, now + remindWindowSec]
      );
      for (const v of expiring) {
        const last = Number(v.last_notified_at || 0);
        if (last && (now - last) < remindCooldownSec) continue;

        const expWib = new Date(Number(v.expires_at) * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const ipPart = v.ip ? ` (IP ${String(v.ip)})` : '';
        await bot.sendMessage(Number(v.user_id),
          `⏰ Pengingat: VPS/RDP kamu${ipPart} akan expired.\n\n🗓️ Expired: ${expWib} WIB\n\nSilakan backup data sebelum expired.`
        ).catch(() => {});
        await db.run('UPDATE vps_instances SET last_notified_at = ? WHERE id = ?', [now, v.id]);
      }
    } catch (e) {
      // ignore
    }

    // 2) Auto delete expired
    try {
      const expired = await db.all(
        `SELECT i.id, i.user_id, i.api_id, i.product_id, i.droplet_id, i.ip, i.expires_at, i.duration_days
         FROM vps_instances i
         WHERE i.status = 1 AND i.expires_at IS NOT NULL AND i.expires_at <= ?`,
        [now]
      );

      for (const v of expired) {
        // Get token
        let token = null;
        try { token = await vpsManager.getDoApiTokenAny(v.api_id); } catch (e) {}
        if (token && v.droplet_id) {
          try { await deleteDroplet(token, v.droplet_id); } catch (e) {}
        }

        // Return stock slot (best-effort)
        if (v.product_id) {
          try { await vpsManager.incrementProductSlotDuration(v.product_id, Number(v.duration_days) || 30); } catch (e) {}
        }

        // Mark deleted (prevent loop)
        await db.run('UPDATE vps_instances SET status = 0, deleted_at = ? WHERE id = ?', [now, v.id]);

        const expWib = new Date(Number(v.expires_at) * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const ipLine = v.ip ? `\n\n🌐 IP: *${String(v.ip)}*` : '';
        await bot.sendMessage(Number(v.user_id),
          `⌛ *Masa aktif habis*\n\nVPS/RDP kamu (ID *${v.id}*) expired pada *${expWib} WIB*${ipLine}\n\nStatus: *Dihapus otomatis*`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    } catch (e) {
      // ignore
    }
  };

  // Run immediately then interval
  tick().catch(() => {});
  return setInterval(() => tick().catch(() => {}), intervalMs);
}

module.exports = { startExpiryWorker };
