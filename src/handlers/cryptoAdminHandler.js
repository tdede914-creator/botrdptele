/**
 * Admin panel for crypto payment settings.
 *
 * Exposes an inline-keyboard menu where admin can:
 *   • view current values of every crypto-related admin_setting
 *   • edit each value via text reply
 *   • toggle rate mode auto ↔ manual instantly
 *   • force-refresh the USD/IDR rate cache
 *
 * Storage: all values live in `admin_settings` (via `adminSettings.setSetting`).
 * The runtime modules (exchangeRate, cryptoPayment, cryptoDepositHandler) all
 * read from the same table so changes take effect on the next request without
 * a restart.
 *
 * Callbacks handled (see handleCryptoAdminCallbacks):
 *   crypto_admin_menu             — main list
 *   crypto_admin_set:<key>        — prompt admin for a new value
 *   crypto_admin_mode:auto        — set rate mode to auto
 *   crypto_admin_mode:manual      — set rate mode to manual
 *   crypto_admin_refresh_rate     — force refresh FX cache
 *
 * Admin session action for text input: 'crypto_admin_set' with `key` payload.
 */

const adminSettings = require('../utils/adminSettings');
const exchangeRate = require('../utils/exchangeRate');
const cryptoPayment = require('../utils/cryptoPayment');
const binanceApi = require('../utils/binanceApi');

/* -------------------------------------------------------------------------- */
/*  Setting metadata                                                          */
/* -------------------------------------------------------------------------- */

// Central catalog of every editable crypto setting. Each entry describes:
//  - label:    human-readable name shown in the menu
//  - kind:     'string' | 'number' | 'integer'
//  - default:  fallback value (must match what the runtime modules assume)
//  - hint:     example shown when admin is prompted for input
//  - validate: (value) => { ok: bool, error?: string, normalized?: any }
const SETTINGS = {
  crypto_binance_pay_id: {
    label: 'Binance Pay ID',
    kind: 'string',
    default: '',
    hint: 'Contoh: 123456789 (nomor Pay ID kamu di Binance)',
    validate: (v) => {
      const s = String(v).trim();
      if (!s) return { ok: false, error: 'Pay ID kosong.' };
      // Binance Pay IDs are typically numeric. Accept alphanumeric to be safe.
      if (!/^[A-Za-z0-9_-]{3,64}$/.test(s)) return { ok: false, error: 'Format Pay ID tidak wajar (huruf/angka/dash/underscore, 3-64 karakter).' };
      return { ok: true, normalized: s };
    }
  },
  crypto_binance_pay_name: {
    label: 'Binance Pay Nama Display',
    kind: 'string',
    default: '',
    hint: 'Nama yang muncul di layar user, misal: BOTRDP Store',
    validate: (v) => ({ ok: true, normalized: String(v || '').trim().slice(0, 64) })
  },
  crypto_bep20_address: {
    label: 'BEP20 Wallet Address',
    kind: 'string',
    default: '',
    hint: 'Contoh: 0xabc...123 (42 karakter, jaringan BSC)',
    validate: (v) => {
      const s = String(v).trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, error: 'Format address BEP20 tidak valid (harus 0x + 40 hex chars).' };
      return { ok: true, normalized: s.toLowerCase() };
    }
  },
  crypto_fee_percentage: {
    label: 'Fee %',
    kind: 'number',
    default: cryptoPayment.DEFAULT_FEE_PERCENTAGE,
    hint: 'Contoh: 3 (untuk 3%). Boleh desimal, misal 2.5.',
    validate: (v) => {
      const n = Number(String(v).replace(',', '.').trim());
      if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: 'Persentase harus 0-100.' };
      return { ok: true, normalized: n };
    }
  },
  crypto_fee_flat_idr: {
    label: 'Fee Flat Minimum (IDR)',
    kind: 'integer',
    default: cryptoPayment.DEFAULT_FEE_FLAT_IDR,
    hint: 'Contoh: 5000 (Rp 5.000 minimum). Set 0 untuk pure %.',
    validate: (v) => {
      const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Fee flat harus integer ≥ 0.' };
      return { ok: true, normalized: n };
    }
  },
  crypto_min_deposit_usdt: {
    label: 'Minimum Deposit (USDT)',
    kind: 'number',
    default: cryptoPayment.DEFAULT_MIN_USDT,
    hint: 'Contoh: 1 (minimum 1 USDT). Boleh desimal.',
    validate: (v) => {
      const n = Number(String(v).replace(',', '.').trim());
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'Minimum harus > 0.' };
      return { ok: true, normalized: n };
    }
  },
  crypto_rate_override_idr: {
    label: 'Rate Override (IDR/USD)',
    kind: 'integer',
    default: 0,
    hint: 'Contoh: 16000 (dipakai jika mode = manual). Set 0 untuk clear.',
    validate: (v) => {
      const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'Rate harus integer ≥ 0.' };
      if (n > 0 && (n < 5_000 || n > 50_000)) return { ok: false, error: 'Rate terlihat tidak wajar (harus 5.000-50.000).' };
      return { ok: true, normalized: n };
    }
  },
  crypto_rate_refresh_hours: {
    label: 'Cache Rate (jam)',
    kind: 'integer',
    default: exchangeRate.DEFAULT_REFRESH_HOURS,
    hint: 'Contoh: 6 (refresh setiap 6 jam). Set 0 untuk selalu live.',
    validate: (v) => {
      const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(n) || n < 0 || n > 168) return { ok: false, error: 'Jam harus 0-168 (max 1 minggu).' };
      return { ok: true, normalized: n };
    }
  },
  crypto_rate_fallback_idr: {
    label: 'Rate Fallback Statis',
    kind: 'integer',
    default: exchangeRate.DEFAULT_FALLBACK_IDR,
    hint: 'Contoh: 15750 (dipakai kalau semua API rate gagal).',
    validate: (v) => {
      const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(n) || n < 5_000 || n > 50_000) return { ok: false, error: 'Fallback rate harus 5.000-50.000.' };
      return { ok: true, normalized: n };
    }
  }
};

const EDITABLE_KEYS = Object.keys(SETTINGS);

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

async function getAllValues() {
  const out = {};
  for (const key of EDITABLE_KEYS) {
    const meta = SETTINGS[key];
    if (meta.kind === 'string') {
      out[key] = (await adminSettings.getSetting(key, '')) || '';
    } else {
      out[key] = await adminSettings.getNumber(key, meta.default);
    }
  }
  out.crypto_rate_mode = (await adminSettings.getSetting('crypto_rate_mode', 'auto')) || 'auto';
  return out;
}

function fmtValue(key, val) {
  if (val === '' || val === null || val === undefined) return '_(kosong)_';
  if (key === 'crypto_bep20_address' || key === 'crypto_binance_pay_id') {
    // Truncate very long strings so the menu doesn't overflow.
    const s = String(val);
    return s.length > 32 ? '`' + s.slice(0, 12) + '…' + s.slice(-8) + '`' : '`' + s + '`';
  }
  if (key === 'crypto_fee_percentage' || key === 'crypto_min_deposit_usdt') return `${val}`;
  if (key === 'crypto_rate_refresh_hours') return `${val} jam`;
  if (typeof val === 'number' && key.includes('idr')) return `Rp ${Number(val).toLocaleString('id-ID')}`;
  return `\`${val}\``;
}

/* -------------------------------------------------------------------------- */
/*  Screens                                                                   */
/* -------------------------------------------------------------------------- */

async function showCryptoAdminMenu(bot, chatId, messageId) {
  const v = await getAllValues();
  const rateInfo = await exchangeRate.getCurrentUsdToIdr();
  const rateSource = rateInfo.source === 'manual'
    ? 'MANUAL'
    : rateInfo.cached ? 'cache' : 'live';

  const apiStatus = binanceApi.isConfigured()
    ? '✅ Configured'
    : '❌ *BINANCE_API_KEY / BINANCE_API_SECRET belum diset*';

  const modeLabel = v.crypto_rate_mode === 'manual' ? '📌 MANUAL' : '🌐 AUTO';

  const text =
    '🪙 *Crypto Payment Settings*\n\n' +
    `API Binance: ${apiStatus}\n` +
    `Rate saat ini: 1 USDT ≈ Rp ${Number(rateInfo.rate).toLocaleString('id-ID')} (${rateSource})\n` +
    `Rate mode: ${modeLabel}\n\n` +
    '*Alamat / ID:*\n' +
    `• Binance Pay ID: ${fmtValue('crypto_binance_pay_id', v.crypto_binance_pay_id)}\n` +
    `• Nama Display: ${fmtValue('crypto_binance_pay_name', v.crypto_binance_pay_name)}\n` +
    `• BEP20 Address: ${fmtValue('crypto_bep20_address', v.crypto_bep20_address)}\n\n` +
    '*Fee & Limit:*\n' +
    `• Fee: ${v.crypto_fee_percentage}% (min ${fmtValue('crypto_fee_flat_idr', v.crypto_fee_flat_idr)})\n` +
    `• Minimum deposit: ${v.crypto_min_deposit_usdt} USDT\n\n` +
    '*FX Rate:*\n' +
    `• Override (manual mode): ${fmtValue('crypto_rate_override_idr', v.crypto_rate_override_idr)}\n` +
    `• Cache TTL: ${v.crypto_rate_refresh_hours} jam\n` +
    `• Fallback statis: ${fmtValue('crypto_rate_fallback_idr', v.crypto_rate_fallback_idr)}`;

  // Two edit buttons per row to keep the keyboard compact.
  const editButtons = [];
  const pairs = [
    ['crypto_binance_pay_id', 'crypto_binance_pay_name'],
    ['crypto_bep20_address', 'crypto_fee_percentage'],
    ['crypto_fee_flat_idr', 'crypto_min_deposit_usdt'],
    ['crypto_rate_override_idr', 'crypto_rate_refresh_hours'],
    ['crypto_rate_fallback_idr', null]
  ];
  for (const [a, b] of pairs) {
    const row = [{ text: `✏️ ${SETTINGS[a].label}`, callback_data: `crypto_admin_set:${a}` }];
    if (b) row.push({ text: `✏️ ${SETTINGS[b].label}`, callback_data: `crypto_admin_set:${b}` });
    editButtons.push(row);
  }

  const modeBtn = v.crypto_rate_mode === 'manual'
    ? { text: '🌐 Switch ke Auto', callback_data: 'crypto_admin_mode:auto' }
    : { text: '📌 Switch ke Manual', callback_data: 'crypto_admin_mode:manual' };

  const inline_keyboard = [
    ...editButtons,
    [modeBtn, { text: '🔄 Refresh Rate', callback_data: 'crypto_admin_refresh_rate' }],
    [{ text: '« Kembali', callback_data: 'back_to_menu' }]
  ];

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard }
  });
}

async function promptCryptoSetting(bot, chatId, messageId, key, sessionManager) {
  const meta = SETTINGS[key];
  if (!meta) {
    return bot.editMessageText('❌ Setting tidak dikenal.', {
      chat_id: chatId, message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'crypto_admin_menu' }]] }
    });
  }

  const current = meta.kind === 'string'
    ? (await adminSettings.getSetting(key, '')) || '(kosong)'
    : await adminSettings.getNumber(key, meta.default);

  sessionManager.setAdminSession(chatId, { action: 'crypto_admin_set', key, messageId });

  await bot.editMessageText(
    `✏️ *Edit: ${meta.label}*\n\n` +
    `Nilai sekarang: \`${current}\`\n\n` +
    `Kirim nilai baru sebagai balasan.\n` +
    `Hint: ${meta.hint}`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'crypto_admin_menu' }]] }
    }
  );
}

async function processCryptoSetting(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getAdminSession(chatId);
  if (!session || session.action !== 'crypto_admin_set') return false;

  const key = session.key;
  const meta = SETTINGS[key];
  if (!meta) {
    sessionManager.clearAdminSession(chatId);
    await bot.sendMessage(chatId, '❌ Setting tidak dikenal.');
    return true;
  }

  const raw = String(msg.text || '').trim();
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}

  const verdict = meta.validate(raw);
  if (!verdict.ok) {
    await bot.sendMessage(chatId, `❌ ${verdict.error}\n\nKirim ulang atau tekan Batal.`);
    return true;
  }

  try {
    await adminSettings.setSetting(key, verdict.normalized);
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Gagal simpan: ${err.message || err}`);
    return true;
  }

  sessionManager.clearAdminSession(chatId);

  // Re-render the main menu with the new value in place.
  try {
    await showCryptoAdminMenu(bot, chatId, session.messageId);
  } catch (_) {
    await bot.sendMessage(chatId, `✅ ${meta.label} disimpan: \`${verdict.normalized}\``, { parse_mode: 'Markdown' });
  }
  return true;
}

async function setRateMode(bot, chatId, messageId, mode) {
  if (mode !== 'auto' && mode !== 'manual') return;
  await adminSettings.setSetting('crypto_rate_mode', mode);
  await showCryptoAdminMenu(bot, chatId, messageId);
}

async function refreshRate(bot, chatId, messageId) {
  const res = await exchangeRate.refreshRateNow();
  if (res.ok) {
    await bot.answerCallbackQuery && bot.answerCallbackQuery?.({
      callback_query_id: null,
      text: `Rate diperbarui: 1 USDT ≈ Rp ${Number(res.rate).toLocaleString('id-ID')}`
    }).catch(() => {});
  }
  await showCryptoAdminMenu(bot, chatId, messageId);
}

async function handleCryptoAdminCallbacks(bot, query, sessionManager) {
  const data = query.data || '';
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (data === 'crypto_admin_menu') {
    await showCryptoAdminMenu(bot, chatId, messageId);
    return true;
  }
  if (data.startsWith('crypto_admin_set:')) {
    const key = data.slice('crypto_admin_set:'.length);
    await promptCryptoSetting(bot, chatId, messageId, key, sessionManager);
    return true;
  }
  if (data.startsWith('crypto_admin_mode:')) {
    const mode = data.slice('crypto_admin_mode:'.length);
    await setRateMode(bot, chatId, messageId, mode);
    return true;
  }
  if (data === 'crypto_admin_refresh_rate') {
    await refreshRate(bot, chatId, messageId);
    return true;
  }
  return false;
}

module.exports = {
  SETTINGS,
  EDITABLE_KEYS,
  showCryptoAdminMenu,
  promptCryptoSetting,
  processCryptoSetting,
  setRateMode,
  refreshRate,
  handleCryptoAdminCallbacks
};
