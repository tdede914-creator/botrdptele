const vpsManager = require('./vpsManager');
const { getAccountInfo, getAccountEmail, providerName } = require('./doApi');
const db = require('../config/database');

function classifyProviderError(result) {
  const msg = String(result?.error || '').toLowerCase();
  const code = result?.statusCode;

  if (code === 401 || code === 403) {
    return { state: code === 401 ? 'unauthorized' : 'forbidden', notify: true };
  }

  if (msg.includes('unauthorized') || msg.includes('invalid') || msg.includes('authenticate') || msg.includes('signature') || msg.includes('credential')) {
    return { state: 'unauthorized', notify: true };
  }

  if (msg.includes('suspend')) return { state: 'suspended', notify: true };
  if (msg.includes('locked')) return { state: 'locked', notify: true };
  if (msg.includes('verify') || msg.includes('verification')) return { state: 'verification', notify: true };

  // Network/rate-limit/provider hiccups should be recorded, but not spam admin as "API Bermasalah".
  return { state: 'temporary_error', notify: false };
}

let running = false;

async function checkDoApisAndNotify(bot) {
  if (running) return;
  running = true;

  try {
    const apis = await vpsManager.listActiveDoApis();
    if (!apis.length) return;

    const targetChatId = process.env.DO_ALERT_CHANNEL_ID || process.env.ALERT_CHANNEL_ID || process.env.ADMIN_ID;
    if (!targetChatId) return;

    for (const api of apis) {
      if (!api?.token) continue;

      const provider = providerName(api.token);
      let email = api.email || null;

      try {
        const accountResult = await getAccountInfo(api.token);

        if (accountResult && accountResult.ok) {
          const account = accountResult.account || {};
          email = email || account.email || account.uuid || await getAccountEmail(api.token) || null;

          if (email && email !== api.email) {
            try { await db.run('UPDATE do_api SET email = ? WHERE id = ?', [email, api.id]); } catch (_) {}
          }

          await db.run(
            `INSERT INTO do_api_health (api_id, state, last_error, last_checked_at)
             VALUES (?, 'ok', NULL, CURRENT_TIMESTAMP)
             ON CONFLICT(api_id) DO UPDATE SET state='ok', last_error=NULL, last_checked_at=CURRENT_TIMESTAMP`,
            [api.id]
          );

          await new Promise((r) => setTimeout(r, 400));
          continue;
        }

        const cls = classifyProviderError(accountResult);
        const state = cls.state;
        const lastError = accountResult?.error || 'Unknown error';

        const prev = await db.get('SELECT state, last_notified_at FROM do_api_health WHERE api_id = ?', [api.id]);
        const prevState = prev?.state || 'unknown';

        await db.run(
          `INSERT INTO do_api_health (api_id, state, last_error, last_checked_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(api_id) DO UPDATE SET state=excluded.state, last_error=excluded.last_error, last_checked_at=CURRENT_TIMESTAMP`,
          [api.id, state, String(lastError || '')]
        );

        const shouldNotify = cls.notify && prevState !== state;
        if (shouldNotify) {
          const label = email ? `${email} - API#${api.id}` : `${provider} API#${api.id}`;
          const text =
            `⚠️ *${provider} API Bermasalah*\n\n` +
            `• Akun: *${String(label).replace(/[*_`]/g, '')}*\n` +
            `• Status: *${state}*\n` +
            `• Detail: ${String(lastError || '').replace(/[*_`]/g, "'").slice(0, 400)}\n` +
            `• Waktu: ${new Date().toLocaleString('id-ID')}`;

          try {
            await bot.sendMessage(targetChatId, text, { parse_mode: 'Markdown' });
            await db.run(`UPDATE do_api_health SET last_notified_at = CURRENT_TIMESTAMP WHERE api_id = ?`, [api.id]);
          } catch (_) {}
        }
      } catch (err) {
        const message = err?.message || String(err);
        const cls = classifyProviderError({ error: message, statusCode: err?.response?.status });
        await db.run(
          `INSERT INTO do_api_health (api_id, state, last_error, last_checked_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(api_id) DO UPDATE SET state=excluded.state, last_error=excluded.last_error, last_checked_at=CURRENT_TIMESTAMP`,
          [api.id, cls.state, String(message || '')]
        );
      }

      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) {
    console.error('API health monitor error:', e);
  } finally {
    running = false;
  }
}

module.exports = {
  checkDoApisAndNotify
};
