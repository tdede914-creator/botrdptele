/**
 * USD -> IDR exchange rate resolver with 3-tier fallback:
 *
 *   1. If admin set MODE=manual  -> always return the admin override value
 *   2. If cache is fresh          -> return cached value (no API hit)
 *   3. Otherwise, try free public rate APIs (in order) and cache the result
 *   4. If every API fails         -> return a hardcoded fallback so the bot
 *                                    never hard-crashes on deposits
 *
 * This is intentionally cheap: rates change slowly (a few % / week for USDT),
 * so caching for 6 hours is fine and keeps us far below any free-tier limits.
 *
 * All settings live in `admin_settings`:
 *   crypto_rate_mode             — 'auto' | 'manual'      (default: 'auto')
 *   crypto_rate_override_idr     — number                  (used when mode=manual)
 *   crypto_rate_refresh_hours    — number                  (default: 6)
 *   crypto_rate_last_value       — cached rate             (managed by this module)
 *   crypto_rate_last_fetched_at  — cache timestamp (ms)    (managed by this module)
 *   crypto_rate_fallback_idr     — hardcoded floor         (default: 15750)
 */

const axios = require('axios');
const adminSettings = require('./adminSettings');

const DEFAULT_FALLBACK_IDR = 15750;
const DEFAULT_REFRESH_HOURS = 6;
const DEFAULT_MODE = 'auto';

// Free public FX APIs. We try them in this order. Both are no-auth.
// Results should be plausible (10_000 < rate < 25_000 for USD/IDR sanity range).
const RATE_SOURCES = [
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    // Response: { result: "success", rates: { IDR: 15784.7, ... } }
    extract: (data) => Number(data?.rates?.IDR)
  },
  {
    name: 'exchangerate.host',
    url: 'https://api.exchangerate.host/latest?base=USD&symbols=IDR',
    // Response: { success: true, rates: { IDR: 15784.7 } }
    extract: (data) => Number(data?.rates?.IDR)
  }
];

function isPlausible(rate) {
  return Number.isFinite(rate) && rate > 10_000 && rate < 25_000;
}

async function fetchLiveRate() {
  for (const src of RATE_SOURCES) {
    try {
      const res = await axios.get(src.url, { timeout: 10_000 });
      if (res.status >= 200 && res.status < 300) {
        const rate = src.extract(res.data);
        if (isPlausible(rate)) {
          return { ok: true, rate, source: src.name };
        }
      }
    } catch (_) {
      // Try next source silently. We log only if all fail.
    }
  }
  return { ok: false, error: 'Semua sumber FX rate gagal atau memberi nilai tidak masuk akal.' };
}

async function getCurrentUsdToIdr() {
  const mode = (await adminSettings.getSetting('crypto_rate_mode', DEFAULT_MODE)) || DEFAULT_MODE;
  const fallbackRate = await adminSettings.getNumber('crypto_rate_fallback_idr', DEFAULT_FALLBACK_IDR);

  // Manual mode: use admin-set fixed value only. No cache, no API call.
  if (String(mode).toLowerCase() === 'manual') {
    const override = await adminSettings.getNumber('crypto_rate_override_idr', 0);
    if (isPlausible(override)) {
      return { rate: override, source: 'manual', cached: false };
    }
    // Manual mode but no valid override configured — fall back gracefully.
    return { rate: fallbackRate, source: 'manual_fallback', cached: false };
  }

  // Auto mode: honor cache if fresh.
  const refreshHours = Math.max(0, await adminSettings.getNumber('crypto_rate_refresh_hours', DEFAULT_REFRESH_HOURS));
  const lastValue = await adminSettings.getNumber('crypto_rate_last_value', 0);
  const lastFetchedAt = await adminSettings.getNumber('crypto_rate_last_fetched_at', 0);
  const cacheTtlMs = refreshHours * 3_600_000;
  const isFresh = lastFetchedAt > 0 && (Date.now() - lastFetchedAt) < cacheTtlMs;

  if (isFresh && isPlausible(lastValue)) {
    return { rate: lastValue, source: 'cache', cached: true, ageMs: Date.now() - lastFetchedAt };
  }

  // Try live API. If it succeeds, cache the result.
  const live = await fetchLiveRate();
  if (live.ok) {
    try {
      await adminSettings.setSetting('crypto_rate_last_value', String(live.rate));
      await adminSettings.setSetting('crypto_rate_last_fetched_at', String(Date.now()));
    } catch (_) { /* cache write failure is non-fatal */ }
    return { rate: live.rate, source: live.source, cached: false };
  }

  // API failure. Use last known value if plausible, else hardcoded fallback.
  if (isPlausible(lastValue)) {
    return { rate: lastValue, source: 'stale_cache', cached: true, warning: 'Sumber live FX gagal, pakai cache lama.' };
  }
  return { rate: fallbackRate, source: 'hardcoded_fallback', cached: false, warning: 'Sumber live FX gagal, pakai fallback statis.' };
}

/**
 * Convert USDT amount -> IDR using the current rate.
 * Note: for stablecoins like USDT we treat 1 USDT ≈ 1 USD; that assumption
 * has held to within ~0.5% for years. If we ever add non-stable coins we'll
 * need per-coin USD price lookup.
 */
async function convertUsdtToIdr(usdtAmount) {
  const info = await getCurrentUsdToIdr();
  const rate = info.rate;
  const idr = Math.floor(Number(usdtAmount) * rate);
  return { idr, rate, source: info.source, cached: !!info.cached, warning: info.warning || null };
}

/**
 * Admin helper: force-refresh the cache immediately. Used by admin menu
 * command "sync rate now". Returns the new rate or an error.
 */
async function refreshRateNow() {
  const live = await fetchLiveRate();
  if (!live.ok) return { ok: false, error: live.error };
  await adminSettings.setSetting('crypto_rate_last_value', String(live.rate));
  await adminSettings.setSetting('crypto_rate_last_fetched_at', String(Date.now()));
  return { ok: true, rate: live.rate, source: live.source };
}

module.exports = {
  getCurrentUsdToIdr,
  convertUsdtToIdr,
  refreshRateNow,
  // Constants exposed for menus that show defaults
  DEFAULT_FALLBACK_IDR,
  DEFAULT_REFRESH_HOURS
};
