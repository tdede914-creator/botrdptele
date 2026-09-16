const fs = require('fs');
const path = require('path');
const safeMessageEditor = require('./safeMessageEdit');

function resolveMenuImagePath() {
  const configured = (process.env.MENU_IMAGE_PATH || '').trim();

  const candidates = [];
  if (configured) {
    candidates.push(configured);
    if (!path.isAbsolute(configured)) {
      candidates.push(path.join(process.cwd(), configured));
    }
  }

  // Fallback penting saat bot dipindah folder / setelah restore backup lama.
  // Contoh: .env lama berisi /root/botrdp1/assets/banner.jpeg, tetapi bot sekarang di /root/bot2.
  candidates.push(path.join(process.cwd(), 'assets', 'banner.jpeg'));
  candidates.push(path.join(__dirname, '..', '..', 'assets', 'banner.jpeg'));

  const found = candidates.find((p) => p && fs.existsSync(p));
  return found || null;
}

function hasMenuImage() {
  return !!(process.env.MENU_IMAGE_URL || resolveMenuImagePath());
}

function getMenuPhoto() {
  if (process.env.MENU_IMAGE_URL) return process.env.MENU_IMAGE_URL;
  const imagePath = resolveMenuImagePath();
  if (imagePath) return fs.createReadStream(imagePath);
  return null;
}

/**
 * Always show menu with banner when MENU_IMAGE_URL or MENU_IMAGE_PATH is configured.
 * Telegram cannot turn an existing text message into a photo message, so for menu
 * screens we delete the old menu message and send a fresh photo+caption.
 */
async function showMenu(bot, chatId, messageId, text, options = {}) {
  if (hasMenuImage()) {
    if (messageId) {
      try { await bot.deleteMessage(chatId, messageId); } catch (e) {}
    }

    try {
      return await bot.sendPhoto(chatId, getMenuPhoto(), { caption: text, ...options });
    } catch (e) {
      console.log('Failed to send menu photo, falling back to text:', e.message);
    }
  }

  if (messageId) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, text, options);
  }
  return bot.sendMessage(chatId, text, options);
}

module.exports = { showMenu, hasMenuImage, resolveMenuImagePath };
