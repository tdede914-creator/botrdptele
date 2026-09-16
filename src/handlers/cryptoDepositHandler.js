/**
 * Crypto deposit wizard.
 *
 * User flow:
 *   [Deposit menu] -> "🪙 Crypto USDT"
 *      -> showCryptoMenu               (callback: crypto_deposit_menu)
 *      -> pick method
 *         -> BEP20:        showBep20Address       (callback: crypto_method_bep20)
 *         -> Binance Pay:  showBinancePayId       (callback: crypto_method_binance_pay)
 *      -> "Kirim TX-ID / Order ID" button
 *         -> promptForTxRef            (callback: crypto_submit:<method>)
 *      -> User types TX-ID / Order ID
 *         -> processTxRefSubmit        (text handler, installType='crypto_deposit_manual')
 *      -> Bot verifies via cryptoPayment.verifyAndCredit
 *      -> Balance is auto-credited or an error/instruction message is shown
 *
 * Session shape while wizard is active:
 *   {
 *     installType: 'crypto_deposit_manual',
 *     step: 'waiting_tx_ref',
 *     method: 'usdt_bep20' | 'binance_pay',
 *     messageId?: number     // the menu message id (for cleanup)
 *   }
 */

const safeMessageEditor = require('../utils/safeMessageEdit');
const adminSettings = require('../utils/adminSettings');
const exchangeRate = require('../utils/exchangeRate');
const cryptoPayment = require('../utils/cryptoPayment');
const binanceApi = require('../utils/binanceApi');

const METHODS = cryptoPayment.METHODS;

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function fmtIdr(n) {
  const v = Math.round(Number(n) || 0);
  return `Rp ${v.toLocaleString('id-ID')}`;
}

function fmtUsdt(n) {
  const v = Number(n) || 0;
  // 4dp is enough for stablecoin display; strip trailing zeros for readability.
  return `${v.toFixed(4).replace(/\.?0+$/, '')} USDT`;
}

/**
 * Build the "current rate + fee" info line. Shown on every crypto screen so
 * the user knows exactly what they'll get before paying.
 */
async function buildRateFeeSummary() {
  const [rateInfo, feeCfg] = await Promise.all([
    exchangeRate.getCurrentUsdToIdr(),
    cryptoPayment.getFeeConfig()
  ]);
  const rateStr = fmtIdr(rateInfo.rate);
  const sourceTag = rateInfo.source === 'manual'
    ? '(manual)'
    : rateInfo.cached ? '(cache)' : '(live)';
  const feeLine = `Fee: ${feeCfg.percentage}% (min ${fmtIdr(feeCfg.flatIdr)})`;
  const minLine = `Minimum: ${feeCfg.minUsdt} USDT`;
  return `💱 Rate: 1 USDT ≈ ${rateStr} ${sourceTag}\n💸 ${feeLine}\n📉 ${minLine}`;
}

/* -------------------------------------------------------------------------- */
/*  Screens                                                                   */
/* -------------------------------------------------------------------------- */

async function showCryptoMenu(bot, chatId, messageId, sessionManager) {
  // If the wizard is currently waiting for input, this "back to menu" click
  // should clear it so a stale session doesn't intercept the next message.
  const existing = sessionManager.getUserSession(chatId);
  if (existing && existing.installType === 'crypto_deposit_manual') {
    sessionManager.clearUserSession(chatId);
  }

  if (!binanceApi.isConfigured()) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '⚠️ *Deposit Crypto belum tersedia*\n\n' +
      'Admin belum konfigurasi Binance API. Silakan pakai metode QRIS untuk sementara, atau minta admin set `BINANCE_API_KEY` & `BINANCE_API_SECRET` di environment.',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'deposit' }]] }
      }
    );
  }

  const summary = await buildRateFeeSummary();

  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🪙 *Deposit via Crypto (USDT)*\n\n' +
    'Pilih metode pembayaran:\n\n' +
    '• *Binance Pay ID* — kirim USDT internal Binance (instant, no on-chain fee).\n' +
    '• *USDT BEP20* — kirim USDT lewat jaringan BNB Smart Chain (fee jaringan ~$0.30).\n\n' +
    `${summary}\n\n` +
    '⚠️ Setelah kirim, kamu wajib submit *TX-ID* (BEP20) atau *Order ID* (Binance Pay). Bot akan verifikasi otomatis ke Binance.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🪙 Binance Pay ID', callback_data: 'crypto_method_binance_pay' }],
          [{ text: '🔗 USDT BEP20', callback_data: 'crypto_method_bep20' }],
          [{ text: '« Kembali', callback_data: 'deposit' }]
        ]
      }
    }
  );
}

async function showBinancePayId(bot, chatId, messageId, sessionManager) {
  const payId = (await adminSettings.getSetting('crypto_binance_pay_id', '')) || '';
  const payName = (await adminSettings.getSetting('crypto_binance_pay_name', '')) || '';
  const summary = await buildRateFeeSummary();

  if (!payId) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '⚠️ Binance Pay ID belum diset admin. Coba metode BEP20 atau QRIS.',
      {
        reply_markup: { inline_keyboard: [
          [{ text: '🔗 USDT BEP20', callback_data: 'crypto_method_bep20' }],
          [{ text: '« Kembali', callback_data: 'crypto_deposit_menu' }]
        ] }
      }
    );
  }

  const nameLine = payName ? `\n👤 Nama: *${payName}*` : '';

  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🪙 *Deposit via Binance Pay ID*\n\n' +
    'Buka aplikasi Binance → *Binance Pay* → *Send* → *Pay ID*.\n\n' +
    `🆔 Pay ID: \`${payId}\`${nameLine}\n\n` +
    `${summary}\n\n` +
    '✅ Setelah kirim, tekan tombol di bawah untuk submit *Order ID* / *Transaction ID*.\n' +
    'ℹ️ Order ID bisa dilihat di Binance → *Transaction History* setelah transfer selesai.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📥 Kirim Order ID', callback_data: `crypto_submit:${METHODS.BINANCE_PAY}` }],
          [{ text: '« Ganti Metode', callback_data: 'crypto_deposit_menu' }]
        ]
      }
    }
  );
}

async function showBep20Address(bot, chatId, messageId, sessionManager) {
  const address = (await adminSettings.getSetting('crypto_bep20_address', '')) || '';
  const summary = await buildRateFeeSummary();

  if (!address) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '⚠️ Alamat BEP20 belum diset admin. Coba metode Binance Pay atau QRIS.',
      {
        reply_markup: { inline_keyboard: [
          [{ text: '🪙 Binance Pay ID', callback_data: 'crypto_method_binance_pay' }],
          [{ text: '« Kembali', callback_data: 'crypto_deposit_menu' }]
        ] }
      }
    );
  }

  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🔗 *Deposit via USDT BEP20*\n\n' +
    '⚠️ *WAJIB pakai jaringan BNB Smart Chain (BEP20)*. Salah jaringan = dana hilang permanen dan tidak bisa direfund.\n\n' +
    `📮 Alamat deposit:\n\`${address}\`\n\n` +
    `${summary}\n\n` +
    '✅ Setelah transfer sukses di wallet kamu, tekan tombol di bawah untuk submit *TX Hash* (Transaction ID).\n' +
    'ℹ️ TX Hash bisa dicek di https://bscscan.com/tx/<hash>. Deposit biasanya butuh 1-5 menit setelah konfirmasi block.',
    {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: '📥 Kirim TX Hash', callback_data: `crypto_submit:${METHODS.USDT_BEP20}` }],
          [{ text: '« Ganti Metode', callback_data: 'crypto_deposit_menu' }]
        ]
      }
    }
  );
}

/**
 * User clicked "Kirim TX-ID". Set the wizard session and edit the message
 * to ask for the TX-ID / Order ID as a plain text reply.
 */
async function promptForTxRef(bot, chatId, messageId, method, sessionManager) {
  if (method !== METHODS.USDT_BEP20 && method !== METHODS.BINANCE_PAY) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '❌ Metode tidak dikenal.',
      { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'crypto_deposit_menu' }]] } }
    );
  }

  const isBep20 = method === METHODS.USDT_BEP20;
  const label = isBep20 ? 'TX Hash (BEP20)' : 'Order ID (Binance Pay)';
  const example = isBep20
    ? '`0x9f8e...c2a1` (66 karakter, dimulai dengan 0x)'
    : '`P_1023456789012345` atau angka panjang';

  const msg = await safeMessageEditor.editMessage(bot, chatId, messageId,
    `📥 *Kirim ${label}*\n\n` +
    `Paste ${label} kamu sebagai balasan pesan ini:\n` +
    `Contoh: ${example}\n\n` +
    '⏱️ Bot akan verifikasi otomatis (1-10 detik).',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Batal', callback_data: 'crypto_deposit_menu' }]]
      }
    }
  );

  sessionManager.setUserSession(chatId, {
    installType: 'crypto_deposit_manual',
    step: 'waiting_tx_ref',
    method,
    messageId: msg?.message_id || messageId
  });
}

/**
 * Text message handler. Wired in index.js like the other manual-install
 * wizards: it checks the session and returns false if not applicable.
 */
async function processTxRefSubmit(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getUserSession(chatId);
  if (!session) return false;
  if (session.installType !== 'crypto_deposit_manual') return false;
  if (session.step !== 'waiting_tx_ref') return false;

  const txRef = String(msg.text || '').trim();
  // Delete the user's message so private TX hashes don't linger in the chat.
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}

  if (!txRef) {
    await bot.sendMessage(chatId, '❌ TX-ID kosong. Coba lagi.');
    return true;
  }

  // Basic shape validation to catch typos before hitting the API.
  if (session.method === METHODS.USDT_BEP20) {
    // BEP20 tx hash is 0x + 64 hex chars.
    if (!/^0x[0-9a-fA-F]{64}$/.test(txRef)) {
      await bot.sendMessage(chatId,
        '❌ Format TX Hash BEP20 tidak valid.\n' +
        'Harus dimulai `0x` diikuti 64 karakter hex (total 66 karakter).\n\n' +
        'Cek TX Hash kamu di BscScan lalu paste ulang.',
        { parse_mode: 'Markdown' }
      );
      return true;
    }
  }
  // Binance Pay Order IDs vary in format (numeric or P_-prefixed), so we
  // don't strict-validate them. `verifyAndCredit` will handle "not found".

  // Clear the session immediately — verify runs async but is a one-shot flow.
  sessionManager.clearUserSession(chatId);

  const status = await bot.sendMessage(chatId, '⏳ Memverifikasi transaksi ke Binance...');

  const result = await cryptoPayment.verifyAndCredit({
    userId: chatId,
    method: session.method,
    txRef
  });

  // Remove the "verifying..." message before showing the final result.
  try { await bot.deleteMessage(chatId, status.message_id); } catch (_) {}

  if (result.ok) {
    const d = result.deposit;
    await bot.sendMessage(chatId,
      '✅ *Deposit Berhasil!*\n\n' +
      `💰 Diterima: ${fmtUsdt(d.amountUsdt)}\n` +
      `💱 Rate: 1 USDT = ${fmtIdr(d.exchangeRate)}\n` +
      `📊 Gross: ${fmtIdr(d.amountIdr)}\n` +
      `💸 Fee: ${fmtIdr(d.feeIdr)} (${d.feePercentage}% atau min ${fmtIdr(d.feeFlatIdr)})\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🎉 *Saldo bertambah: ${fmtIdr(d.netCreditIdr)}*\n\n` +
      `🧾 TX Ref: \`${d.txRef}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '💰 Cek Saldo', callback_data: 'check_balance' }],
          [{ text: '🏠 Menu Utama', callback_data: 'back_to_menu' }]
        ] }
      }
    );
    return true;
  }

  if (result.alreadyClaimed) {
    await bot.sendMessage(chatId,
      '⚠️ *TX-ID sudah diklaim*\n\n' +
      'Transaksi ini pernah diproses sebelumnya. Setiap TX-ID hanya bisa dipakai satu kali.\n\n' +
      'Kalau kamu yakin ini adalah transaksi baru dan bukan duplikat, hubungi admin.',
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Menu Deposit', callback_data: 'deposit' }]] }
      }
    );
    return true;
  }

  if (result.pendingConfirmation) {
    await bot.sendMessage(chatId,
      `⏳ ${result.error}\n\n` +
      'Coba submit TX-ID lagi setelah 2-3 menit.',
      {
        reply_markup: { inline_keyboard: [
          [{ text: '🔄 Coba Lagi', callback_data: `crypto_submit:${session.method}` }],
          [{ text: '« Menu Deposit', callback_data: 'deposit' }]
        ] }
      }
    );
    return true;
  }

  if (result.notFound) {
    await bot.sendMessage(chatId,
      `❌ ${result.error}\n\n` +
      'Pastikan:\n' +
      '• Pembayaran sudah sukses di sisi kamu\n' +
      '• TX-ID di-copy lengkap tanpa spasi\n' +
      '• Untuk BEP20: pakai jaringan BSC (bukan ERC20/TRC20)\n' +
      '• Untuk Binance Pay: pakai Order ID / Transaction ID dari Transaction History',
      {
        reply_markup: { inline_keyboard: [
          [{ text: '🔄 Coba Lagi', callback_data: `crypto_submit:${session.method}` }],
          [{ text: '« Menu Deposit', callback_data: 'deposit' }]
        ] }
      }
    );
    return true;
  }

  await bot.sendMessage(chatId,
    `❌ Verifikasi gagal.\n${result.error || 'Unknown error.'}`,
    {
      reply_markup: { inline_keyboard: [
        [{ text: '🔄 Coba Lagi', callback_data: `crypto_submit:${session.method}` }],
        [{ text: '« Menu Deposit', callback_data: 'deposit' }]
      ] }
    }
  );
  return true;
}

/**
 * Dispatch a `crypto_*` callback. Called from index.js callback_query router.
 * Returns true if handled, false if not a crypto-menu callback (so other
 * routers get a chance).
 */
async function handleCryptoCallbacks(bot, query, sessionManager) {
  const data = query.data || '';
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  if (data === 'crypto_deposit_menu') {
    await showCryptoMenu(bot, chatId, messageId, sessionManager);
    return true;
  }
  if (data === 'crypto_method_binance_pay') {
    await showBinancePayId(bot, chatId, messageId, sessionManager);
    return true;
  }
  if (data === 'crypto_method_bep20') {
    await showBep20Address(bot, chatId, messageId, sessionManager);
    return true;
  }
  if (data.startsWith('crypto_submit:')) {
    const method = data.slice('crypto_submit:'.length);
    await promptForTxRef(bot, chatId, messageId, method, sessionManager);
    return true;
  }
  return false;
}

module.exports = {
  showCryptoMenu,
  showBinancePayId,
  showBep20Address,
  promptForTxRef,
  processTxRefSubmit,
  handleCryptoCallbacks
};
