function getNotifyChatId() {
  const raw = process.env.ORDER_NOTIFY_CHAT_ID || process.env.NOTIFY_CHANNEL_ID || '';
  const v = String(raw).trim();
  return v ? v : null;
}

function getTestimonialChatId() {
  const raw =
    process.env.TESTIMONI_NOTIFY_CHAT_ID ||
    process.env.TESTIMONI_CHANNEL_ID ||
    process.env.TESTI_CHANNEL_ID ||
    '';
  const v = String(raw).trim();
  return v ? v : null;
}

function getTestimonialImage() {
  const raw =
    process.env.TESTIMONI_IMAGE_URL ||
    process.env.TESTIMONI_IMAGE_PATH ||
    process.env.TESTI_IMAGE_PATH ||
    '';
  const v = String(raw).trim();
  return v ? v : null;
}

/**
 * Send notification to Telegram channel/group when an order succeeds.
 * Set ORDER_NOTIFY_CHAT_ID in .env to the channel/group id (e.g. -100xxxxxxxxxx).
 */
async function notifyOrderSuccess(bot, payload) {
  const chatId = getNotifyChatId();
  if (!chatId) return;

  // Keep header consistent for both VPS & RDP as requested.
  const headerType = 'VPS/RDP';
  // Optional: allow other events like REBUILD/RESET while keeping the same format.
  const eventLabel = String(payload.event || 'ORDER').toUpperCase();
  const ip = payload.ip || '-';
  const spec = payload.spec || '-';
  const durationDays = payload.durationDays != null ? Number(payload.durationDays) : null;
  const apiId = payload.apiId != null ? `API#${payload.apiId}` : '-';
  const price = payload.price != null ? Number(payload.price) : null;
  const region = payload.region ? String(payload.region) : null;
  const windows = payload.windows ? String(payload.windows) : null;
  const buyerId = payload.buyerId || payload.buyer || payload.userId || payload.user_id || null;

  // Resolve email if not provided
  let apiEmail = payload.apiEmail || null;
  if (!apiEmail && payload.apiId != null) {
    try {
      const vpsManager = require('./vpsManager');
      apiEmail = await vpsManager.getDoApiEmail(Number(payload.apiId));
    } catch (_) {
      apiEmail = null;
    }
  }

  const fmtPrice = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    // Indonesian thousands separators
    return n.toLocaleString('id-ID');
  };

  const apiLine = apiEmail ? `${apiId} (${apiEmail})` : apiId;
  const buyerLine = buyerId ? `\n👤 BUYER ID: ${buyerId}` : '';
  const priceLine = price != null ? `\n📝 HARGA: Rp. ${fmtPrice(price)}` : '';
  const durationLabel = (() => {
    if (durationDays == null || !Number.isFinite(durationDays)) return null;
    if (durationDays === 1) return 'Harian';
    if (durationDays === 7) return 'Mingguan';
    if (durationDays === 30) return 'Bulanan';
    return `${durationDays} hari`;
  })();
  const durationLine = durationLabel ? `\n📝 DURASI: ${durationLabel}` : '';
  const regionLine = region ? `\n📝 REGION: ${region}` : '';
  const windowsLine = windows ? `\n📝 WINDOWS: ${windows}` : '';

  const text =
    `✅ ${eventLabel} ${headerType} BERHASIL\n` +
    `📝 IP: ${ip}` +
    `${buyerLine}\n` +
    `📝 Spesifikasi:\n${spec}\n` +
    `📝 DARI API: ${apiLine}` +
    `${durationLine}` +
    `${priceLine}` +
    `${regionLine}` +
    `${windowsLine}`;

  try {
    await bot.sendMessage(chatId, text);
  } catch (e) {
    // Do not interrupt user flow if channel notification fails
    console.error('Notify channel failed:', e?.message || e);
  }
}

/**
 * Minimal "testimoni" notification:
 * ✅ ORDER BERHASIL
 * 🛍️ PRODUK: ...
 *
 * Config:
 * - TESTIMONI_CHANNEL_ID (or TESTI_CHANNEL_ID)
 * - TESTIMONI_IMAGE_PATH or TESTIMONI_IMAGE_URL (optional)
 */
async function notifyOrderTestimonial(bot, payload) {
  const chatId = getTestimonialChatId();
  if (!chatId) return;

  const productName = String(payload?.productName || payload?.product || payload?.name || 'PRODUK').trim();
  const caption = `✅ ORDER BERHASIL\n🛍️ PRODUK: ${productName}`;

  try {
    const img = getTestimonialImage();
    if (img) {
      if (/^https?:\/\//i.test(img)) {
        await bot.sendPhoto(chatId, img, { caption });
      } else {
        const fs = require('fs');
        await bot.sendPhoto(chatId, fs.createReadStream(img), { caption });
      }
    } else {
      await bot.sendMessage(chatId, caption);
    }
  } catch (e) {
    console.error('Testimonial notify failed:', e?.message || e);
  }
}

/**
 * Detailed shop notification (channel #1):
 * used to track what products are sold.
 */
async function notifyShopSaleDetailed(bot, payload) {
  const chatId = getNotifyChatId();
  if (!chatId) return;

  const productName = String(payload?.productName || payload?.product || payload?.name || payload?.code || 'PRODUK').trim();
  const qty = payload?.qty != null ? Number(payload.qty) : null;
  const amount = payload?.amount != null ? Number(payload.amount) : null;
  const orderId = payload?.orderId != null ? String(payload.orderId) : null;
  const buyer = payload?.buyer != null ? String(payload.buyer) : null;

  const fmtPrice = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    return n.toLocaleString('id-ID');
  };

  const lines = [
    '✅ ORDER SHOP BERHASIL',
    `🛍️ PRODUK: ${productName}`,
  ];
  if (qty != null && Number.isFinite(qty)) lines.push(`🔢 QTY: ${qty}`);
  if (amount != null && Number.isFinite(amount)) lines.push(`💰 TOTAL: Rp ${fmtPrice(amount)}`);
  if (buyer) lines.push(`👤 BUYER: ${buyer}`);
  if (orderId) lines.push(`🧾 ORDER ID: ${orderId}`);

  try {
    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (e) {
    console.error('Shop notify failed:', e?.message || e);
  }
}

async function notifyCloud9OrderSuccess(bot, payload) {
  const chatId = getNotifyChatId();
  if (!chatId) return;

  const fmtPrice = (n) => {
    const num = Number(n || 0);
    return Number.isFinite(num) ? num.toLocaleString('id-ID') : '0';
  };

  let apiEmail = payload?.apiEmail || null;
  if (!apiEmail && payload?.apiId != null) {
    try {
      const vpsManager = require('./vpsManager');
      apiEmail = await vpsManager.getDoApiEmail(Number(payload.apiId));
    } catch (_) {
      apiEmail = null;
    }
  }

  const apiId = payload?.apiId != null ? `API#${payload.apiId}` : '-';
  const apiLine = apiEmail ? `${apiId} (${apiEmail})` : apiId;
  const userId = payload?.userId || payload?.buyerId || payload?.chatId || '-';
  const ip = payload?.ip || '-';
  const url = payload?.url || (ip !== '-' ? `http://${ip}:${payload?.port || 8000}` : '-');
  const size = payload?.size || payload?.sizeSlug || '-';
  const region = payload?.region || '-';
  const durationDays = payload?.durationDays || '-';
  const price = payload?.price != null ? fmtPrice(payload.price) : null;

  const lines = [
    '✅ ORDER CLOUD9 BERHASIL',
    `👤 USER ID: ${userId}`,
    `🌐 IP: ${ip}`,
    `🔗 URL: ${url}`,
    `📦 SIZE: ${size}`,
    `📍 REGION: ${region}`,
    `⏳ MASA AKTIF: ${durationDays} hari`,
    `📝 DARI API: ${apiLine}`
  ];
  if (price) lines.push(`💰 HARGA: Rp ${price}`);

  try {
    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (e) {
    console.error('Cloud9 notify failed:', e?.message || e);
  }
}

async function notifyCloud9Expired(bot, payload) {
  const chatId = getNotifyChatId();
  if (!chatId) return;

  const userId = payload?.userId || payload?.user_id || '-';
  const ip = payload?.ip || '-';
  const instanceId = payload?.instanceId || payload?.id || '-';
  const region = payload?.region || '-';

  const lines = [
    '⌛ CLOUD9 EXPIRED & DIHAPUS',
    `🆔 ID: ${instanceId}`,
    `👤 USER ID: ${userId}`,
    `🌐 IP: ${ip}`,
    `📍 REGION: ${region}`
  ];

  try {
    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (e) {
    console.error('Cloud9 expired notify failed:', e?.message || e);
  }
}


async function notifyRentOrderSuccess(bot, payload) {
  const chatId = getNotifyChatId();
  if (!chatId) return;

  const fmtPrice = (n) => {
    const num = Number(n || 0);
    return Number.isFinite(num) ? num.toLocaleString('id-ID') : '0';
  };

  const userId = payload?.userId || payload?.user_id || '-';
  const username = payload?.username ? '@' + String(payload.username).replace(/^@/, '') : '-';
  const plan = payload?.planLabel || payload?.plan || '-';
  const days = payload?.days != null ? Number(payload.days) : null;
  const price = payload?.price != null ? Number(payload.price) : null;
  const method = payload?.method || '-';
  const expiresAt = payload?.expiresAt || payload?.expires_at || null;

  const lines = [
    '✅ ORDER SEWA BOT BERHASIL',
    `👤 USER ID: ${userId}`,
    `🔗 USERNAME: ${username}`,
    `📦 PAKET: ${plan}${days ? ' / ' + days + ' hari' : ''}`,
  ];
  if (price != null && Number.isFinite(price)) lines.push(`💰 HARGA: Rp ${fmtPrice(price)}`);
  lines.push(`💳 METODE: ${method}`);
  if (expiresAt) lines.push(`📅 AKTIF SAMPAI: ${expiresAt}`);

  try {
    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (e) {
    console.error('Rent notify failed:', e?.message || e);
  }
}

async function notifyFastpanelOrderSuccess(bot, payload) {
  const chatId = getNotifyChatId();
  if (!chatId) return;

  const fmtPrice = (n) => {
    const num = Number(n || 0);
    return Number.isFinite(num) ? num.toLocaleString('id-ID') : '0';
  };

  let apiEmail = payload?.apiEmail || null;
  if (!apiEmail && payload?.apiId != null) {
    try {
      const vpsManager = require('./vpsManager');
      apiEmail = await vpsManager.getDoApiEmail(Number(payload.apiId));
    } catch (_) {
      apiEmail = null;
    }
  }

  const apiId = payload?.apiId != null ? `API#${payload.apiId}` : '-';
  const apiLine = apiEmail ? `${apiId} (${apiEmail})` : apiId;
  const userId = payload?.userId || payload?.buyerId || payload?.chatId || '-';
  const ip = payload?.ip || '-';
  const url = payload?.url || (ip !== '-' ? `https://${ip}:${payload?.port || 8888}/` : '-');
  const size = payload?.size || payload?.sizeSlug || '-';
  const region = payload?.region || '-';
  const provider = payload?.provider ? String(payload.provider).toUpperCase() : '-';
  const durationDays = payload?.durationDays || '-';
  const username = payload?.username || 'fastuser';
  const price = payload?.price != null ? fmtPrice(payload.price) : null;

  const lines = [
    '✅ ORDER FASTPANEL BERHASIL',
    `👤 USER ID: ${userId}`,
    `🌐 IP: ${ip}`,
    `🔗 URL: ${url}`,
    `👥 PANEL USER: ${username}`,
    `☁️ PROVIDER: ${provider}`,
    `📦 SIZE: ${size}`,
    `📍 REGION: ${region}`,
    `⏳ MASA AKTIF: ${durationDays} hari`,
    `📝 DARI API: ${apiLine}`
  ];
  if (price) lines.push(`💰 HARGA: Rp ${price}`);

  try {
    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (e) {
    console.error('Fastpanel notify failed:', e?.message || e);
  }
}

async function notifyFastpanelExpired(bot, payload) {
  const chatId = getNotifyChatId();
  if (!chatId) return;

  const userId = payload?.userId || payload?.user_id || '-';
  const ip = payload?.ip || '-';
  const instanceId = payload?.instanceId || payload?.id || '-';
  const region = payload?.region || '-';

  const lines = [
    '⌛ FASTPANEL EXPIRED & DIHAPUS',
    `🆔 ID: ${instanceId}`,
    `👤 USER ID: ${userId}`,
    `🌐 IP: ${ip}`,
    `📍 REGION: ${region}`
  ];

  try {
    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (e) {
    console.error('Fastpanel expired notify failed:', e?.message || e);
  }
}

module.exports = { notifyOrderSuccess, notifyOrderTestimonial, notifyShopSaleDetailed, notifyRentOrderSuccess, notifyCloud9OrderSuccess, notifyCloud9Expired, notifyFastpanelOrderSuccess, notifyFastpanelExpired };
