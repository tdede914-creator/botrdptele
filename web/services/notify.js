/**
 * Notifikasi channel untuk order via WEB. Proses web tidak punya objek bot
 * Telegram, jadi kita buat "botShim" ringan yang mengirim langsung ke Telegram
 * Bot API (pakai TELEGRAM_BOT_TOKEN), lalu memakai ULANG orderNotifier yang sama
 * dengan bot -> notif muncul di channel yang sama & format identik.
 */
const axios = require('axios');
const orderNotifier = require('../../src/utils/orderNotifier');

function tgApi(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.resolve();
  return axios.post(`https://api.telegram.org/bot${token}/${method}`, payload, { timeout: 15000 })
    .catch((e) => { console.warn('[web notify] telegram', method, e.message || e); });
}

// Shim minimal yang meniru antarmuka bot (hanya sendMessage/sendPhoto yang dipakai orderNotifier).
const botShim = {
  sendMessage: (chatId, text, opts = {}) => tgApi('sendMessage', { chat_id: chatId, text, ...(opts || {}) }),
  sendPhoto: (chatId, photo, opts = {}) => {
    // Hanya URL string yang didukung via JSON. Stream file lokal -> fallback teks caption.
    if (typeof photo === 'string') return tgApi('sendPhoto', { chat_id: chatId, photo, ...(opts || {}) });
    return tgApi('sendMessage', { chat_id: chatId, text: (opts && opts.caption) || '✅ ORDER BERHASIL' });
  }
};

async function orderSuccess(payload) { try { await orderNotifier.notifyOrderSuccess(botShim, payload); } catch (e) { console.warn('[web notify]', e.message || e); } }
async function testimonial(payload) { try { await orderNotifier.notifyOrderTestimonial(botShim, payload); } catch (_) {} }
async function cloud9Success(payload) { try { await orderNotifier.notifyCloud9OrderSuccess(botShim, payload); } catch (e) { console.warn('[web notify]', e.message || e); } }
async function fastpanelSuccess(payload) { try { await orderNotifier.notifyFastpanelOrderSuccess(botShim, payload); } catch (e) { console.warn('[web notify]', e.message || e); } }

module.exports = { orderSuccess, testimonial, cloud9Success, fastpanelSuccess, botShim };
