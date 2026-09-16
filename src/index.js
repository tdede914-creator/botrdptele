require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { scheduleJob } = require('node-schedule');
const { handleInstallDedicatedRDP, handleDedicatedVPSCredentials, showDedicatedOSSelection, handleDedicatedOSSelection, handleDedicatedAuthSelection } = require('./handlers/dedicatedRdpHandler');
const { handleDeposit, handleDepositQris, handleDepositAmount, handlePendingPayment } = require('./handlers/depositHandler');
const { handleAddBalance, processAddBalance, handleBroadcast, processBroadcast, handleAtlanticAdmin } = require('./handlers/adminHandler');
const cryptoDepositHandler = require('./handlers/cryptoDepositHandler');
const cryptoAdminHandler = require('./handlers/cryptoAdminHandler');
const { handleFAQ } = require('./handlers/faqHandler');
const { handleTutorial } = require('./handlers/tutorialHandler');
const { handleProviders } = require('./handlers/providerHandler');
const vpsOrder = require('./handlers/vpsOrderHandler');
const vpsAdmin = require('./handlers/vpsAdminHandler');
const rdpOrder = require('./handlers/rdpOrderHandler');
const shopHandler = require('./handlers/shopHandler');
const renterHandler = require('./handlers/renterHandler');
const renterPremiumHandler = require('./handlers/renterPremiumHandler');
const { resolve: cbResolve } = require('./utils/cbToken');
const cloud9Handler = require('./handlers/cloud9Handler');
const fastpanelHandler = require('./handlers/fastpanelHandler');
const backupHandler = require('./handlers/backupHandler');
const renterManager = require('./utils/renterManager');
const { handleWithdrawBalance } = require('./handlers/withdrawHandler');
const { handleSaveAccount } = require('./handlers/accountHandler');
const { getUser, isAdmin, getBalance } = require('./utils/userManager');
const { createMainMenu } = require('./utils/keyboard');
const adminSettings = require('./utils/adminSettings');

const PaymentTracker = require('./utils/paymentTracker');
const ShopPaymentTracker = require('./utils/shopPaymentTracker');
const DatabaseBackup = require('./utils/dbBackup');
const selfRestart = require('./utils/selfRestart');
const { getUptime } = require('./utils/uptime');
const safeMessageEditor = require('./utils/safeMessageEdit');
const menuBanner = require('./utils/menuBanner');
const SessionManager = require('./utils/sessionManager');
const ErrorHandler = require('./utils/errorHandler');
const DOHealthMonitor = require('./utils/doHealthMonitor');
const backupManager = require('./utils/backupManager');
const axios = require('axios');
const qs = require('qs');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is required');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const { startExpiryWorker } = require('./utils/expiryWorker');
startExpiryWorker(bot);

/**
 * Telegram sometimes sends menus as PHOTO+CAPTION (e.g., QRIS / banner).
 * If we try to editMessageText on a non-text message, Telegram returns:
 * "400 Bad Request: there is no text in the message to edit".
 *
 * This wrapper makes editMessageText resilient by falling back to editMessageCaption.
 */
const __origEditMessageText = bot.editMessageText.bind(bot);
bot.editMessageText = async (text, options) => {
  try {
    return await __origEditMessageText(text, options);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    // If the target message is a photo/document/etc, try editing caption instead.
    if (msg.includes('there is no text in the message to edit')) {
      try {
        return await bot.editMessageCaption(text, options);
      } catch (err2) {
        // Re-throw original error if caption edit also fails
        throw err;
      }
    }
    throw err;
  }
};

const sessionManager = new SessionManager();
const errorHandler = new ErrorHandler(bot, sessionManager);

const dbBackup = new DatabaseBackup(bot);

console.log('🤖 RDP Installation Bot started successfully!');
try { cloud9Handler.startCloud9ExpiryScheduler(bot); } catch (e) { console.error('Cloud9 expiry scheduler start error:', e.message || e); }
try { fastpanelHandler.startFastpanelExpiryScheduler(bot); } catch (e) { console.error('Fastpanel expiry scheduler start error:', e.message || e); }
// One-time combo migration: converts legacy vps/rdp product rows into shared 'combo' rows.
// Runs on first boot after upgrade; subsequent boots are no-ops (idempotent via admin_settings flag).
try {
    const { runComboMigration } = require('./utils/comboMigration');
    runComboMigration().catch(e => console.error('Combo migration error:', e.message || e));
} catch (e) { console.error('Combo migration start error:', e.message || e); }
console.log(`📅 Started at: ${new Date().toLocaleString('id-ID')}`);

function formatWaktuWIB() {
    const bulan = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    // Shift to WIB (UTC+7) so the format is deterministic regardless of server TZ / Node ICU.
    const now = new Date(Date.now() + 7 * 3600 * 1000);
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const mm = bulan[now.getUTCMonth()];
    const yyyy = now.getUTCFullYear();
    const HH = String(now.getUTCHours()).padStart(2, '0');
    const MM = String(now.getUTCMinutes()).padStart(2, '0');
    return `${dd} ${mm} ${yyyy}, ${HH}:${MM} WIB`;
}

async function buildUserMenu(chatId, firstName) {
    const balance = await getBalance(chatId);
    const pendingPayment = await PaymentTracker.getPendingPayment(chatId);
    const isUserAdmin = isAdmin(chatId);
    const installCost = await adminSettings.getNumber('install_rdp_cost', 5000);
    const cloud9Cost = await adminSettings.getNumber('cloud9_install_price', 10000);
    const fastpanelCost = await adminSettings.getNumber('fastpanel_install_price', 15000);
    const monthlyUsers = await renterManager.countMonthlyRenters();

    const rupiah = (n) => Number(n || 0).toLocaleString('id-ID');
    const saldoText = typeof balance === 'string'
        ? balance
        : `Rp ${rupiah(balance)}`;

    const welcomeMessage =
        `╔══════════════════════════════════╗\n` +
        `   🌐  *KOBONG CLOUD SERVER*  🌐\n` +
        `     _One-Stop Cloud Solutions_\n` +
        `╚══════════════════════════════════╝\n\n` +
        `👋 Halo, *${firstName || 'User'}*!\n` +
        `💰 Saldo               : ${saldoText}\n` +
        `👥 Penyewa aktif       : ${monthlyUsers} pengguna bulan ini\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `→  *LAYANAN KAMI*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🖥️  *RDP & VPS*\n` +
        `    • Order VPS (Auto-Deploy)\n` +
        `    • Order RDP Windows (Ready-to-Use)\n` +
        `    • Jasa Install RDP        — Rp ${rupiah(installCost)}\n` +
        `    • Sewa RDP Dedicated\n\n` +
        `☁️  *Development & Panel*\n` +
        `    • Cloud9 IDE — Order & Install (Rp ${rupiah(cloud9Cost)})\n` +
        `    • Fastpanel  — Order & Install (Rp ${rupiah(fastpanelCost)})  · NEW\n\n` +
        `🛒  *Marketplace*\n` +
        `    • Produk Digital (Shop akun & lisensi)\n\n` +
        `💳  *Utilitas*\n` +
        `    • Deposit saldo otomatis (QRIS / E-Wallet)\n` +
        `    • Tutorial lengkap tiap layanan\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⏰ Uptime : ${getUptime()}\n` +
        `🕐 Waktu  : ${formatWaktuWIB()}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `  Silakan pilih layanan di bawah ⬇️`;

    return {
        text: welcomeMessage,
        options: { parse_mode: 'Markdown', ...createMainMenu(isUserAdmin, !!pendingPayment) }
    };
}

async function sendUserMenu(chatId, firstName) {
    const menu = await buildUserMenu(chatId, firstName);
    await menuBanner.showMenu(bot, chatId, null, menu.text, menu.options);
}

async function editUserMenu(chatId, messageId, firstName) {
    const menu = await buildUserMenu(chatId, firstName);
    await menuBanner.showMenu(bot, chatId, messageId, menu.text, menu.options);
}

// Setup global error handlers
ErrorHandler.setupGlobalErrorHandlers();

scheduleJob('0 */6 * * *', () => {
    PaymentTracker.cleanupExpiredPayments();
    ShopPaymentTracker.cleanupExpiredPayments().catch(() => {});
    console.log('🧹 Cleaned up expired payments');
});

// DigitalOcean account health monitoring (suspend/locked/verification)
scheduleJob('*/10 * * * *', () => {
    DOHealthMonitor.checkDoApisAndNotify(bot);
});

dbBackup.scheduleBackup();

// Auto backup VPS/RDP dimatikan.
 // Backup RDP sekarang hanya manual dan meminta password RDP terbaru.
 // Kalau suatu saat ingin mengaktifkan lagi, set ENABLE_AUTO_BACKUP=1 di .env.
if (process.env.ENABLE_AUTO_BACKUP === '1') {
    scheduleJob('0 */3 * * *', () => {
        backupManager.runAutoBackups(bot).catch((e) => console.error('Auto backup VPS/RDP error:', e));
    });
} else {
    console.log('Auto backup VPS/RDP disabled. Manual backup only.');
}

bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        await getUser(chatId);
        await renterManager.updateRenterUsername(chatId, msg.from.username || null);
        if (!isAdmin(chatId) && await renterManager.isActiveRenter(chatId)) {
            await renterHandler.showRenterMenu(bot, chatId, null);
            return;
        }
        await sendUserMenu(chatId, msg.from.first_name || 'User');
    } catch (error) {
        console.error('Start command error:', error);
        await bot.sendMessage(chatId, '❌ Terjadi kesalahan. Silakan coba lagi.');
    }
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const user = await getUser(chatId);
        const balance = await getBalance(chatId);
        const pendingPayment = await PaymentTracker.getPendingPayment(chatId);

        const statusMessage = `📊 *Status Akun*\n\n` +
            `👤 User ID: \`${chatId}\`\n` +
            `💰 Saldo: ${typeof balance === 'string' ? balance : `Rp ${balance.toLocaleString()}`}\n` +
            `📅 Bergabung: ${new Date(user.created_at).toLocaleDateString('id-ID')}\n` +
            `📋 Tagihan: ${pendingPayment ? '🟡 Ada' : '🟢 Tidak ada'}\n\n` +
            `⏰ Bot Uptime: ${getUptime()}`;

        await bot.sendMessage(chatId, statusMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '🏠 Menu Utama', callback_data: 'back_to_menu' }
                ]]
            }
        });
    } catch (error) {
        console.error('Status command error:', error);
        await bot.sendMessage(chatId, '❌ Gagal mengambil status akun.');
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
        if (data === 'noop') {
            // keep-alive callback
            bot.answerCallbackQuery(query.id).catch(() => {});
            return;
        }

        // Ack callback ASAP to avoid 'query is too old' errors
        bot.answerCallbackQuery(query.id).catch(() => {});

    try {
        if (data === 'back_to_menu') {
            sessionManager.clearAllSessions(chatId);
            if (!isAdmin(chatId) && await renterManager.isActiveRenter(chatId)) {
                await renterHandler.showRenterMenu(bot, chatId, messageId);
                return;
            }

            await editUserMenu(chatId, messageId, query.from.first_name || 'User');
        }
        else if (data === 'install_rdp') {
            await handleInstallDedicatedRDP(bot, chatId, messageId, sessionManager);
        }
        else if (data === 'install_dedicated_rdp') {
            await handleInstallDedicatedRDP(bot, chatId, messageId, sessionManager);
        }
        else if (data === 'show_windows_selection') {
            await showWindowsSelection(bot, chatId, messageId, 0);
        }
        else if (data.startsWith('windows_')) {
            await handleWindowsSelection(bot, query, sessionManager);
        }
        else if (data.startsWith('page_')) {
            await handlePageNavigation(bot, query, sessionManager);
        }
        else if (data === 'back_to_windows') {
            await showWindowsSelection(bot, chatId, messageId, 0);
        }
        else if (data === 'dedicated_auth_password' || data === 'dedicated_auth_key') {
            await handleDedicatedAuthSelection(bot, query, sessionManager);
        }
        else if (data === 'show_dedicated_os_selection') {
            await showDedicatedOSSelection(bot, chatId, messageId);
        }
        else if (data.startsWith('dedicated_os_')) {
            await handleDedicatedOSSelection(bot, query, sessionManager);
        }
        else if (data === 'back_to_dedicated_os') {
            await showDedicatedOSSelection(bot, chatId, messageId);
        }
        else if (data === 'continue_no_kvm') {
            await showWindowsSelection(bot, chatId, messageId, 0);
        }
        else if (data === 'cancel_installation') {
    const cancelSession = sessionManager.getUserSession(chatId) || {};
    const backToRenter = !!cancelSession.freeForRenter;
    sessionManager.clearAllSessions(chatId);
    if (backToRenter) {
        await renterHandler.showRenterMenu(bot, chatId, messageId);
        return;
    }

    await editUserMenu(chatId, messageId, query.from.first_name || 'User');
}

        else if (data === 'deposit') {
            // NEW: 'deposit' now shows the payment-method picker (QRIS vs Crypto).
            // No session is set here — the picker branches to `deposit_qris` or
            // `crypto_deposit_menu` depending on user choice.
            await handleDeposit(bot, chatId, messageId);
        }
        else if (data === 'deposit_qris') {
            // Legacy QRIS amount-input flow, now reached only after the user
            // picks QRIS on the method picker.
            const session = await handleDepositQris(bot, chatId, messageId);
            if (session) sessionManager.setDepositSession(chatId, session);
        }
        else if (data === 'crypto_deposit_menu' ||
                 data === 'crypto_method_binance_pay' ||
                 data === 'crypto_method_bep20' ||
                 data.startsWith('crypto_submit:')) {
            await cryptoDepositHandler.handleCryptoCallbacks(bot, query, sessionManager);
        }
        else if (data === 'withdraw_balance') {
            const accountSession = sessionManager.getAccountSession(chatId);
            if (!accountSession || !accountSession.bankCode || !accountSession.accountNumber || !accountSession.accountHolderName) {
                await handleSaveAccount(bot, chatId, messageId, sessionManager);
            } else {
                await handleWithdrawBalance(bot, chatId, messageId, sessionManager);
            }
        }
        else if (data.startsWith('bank_')) {
            const bankCode = data.split('_')[1].toUpperCase();
            const accountSession = sessionManager.getAccountSession(chatId);
            accountSession.bankCode = bankCode;
            accountSession.step = 'waiting_account_number';
            accountSession.messageId = messageId;
            sessionManager.setAccountSession(chatId, accountSession);

            await bot.editMessageText('Silakan masukkan nomor rekening:', {
                chat_id: chatId,
                message_id: messageId
            });
        }
        else if (data === 'cancel_withdraw') {
            sessionManager.clearWithdrawSession(chatId);
            await bot.editMessageText('Withdrawal cancelled.', {
                chat_id: chatId,
                message_id: messageId
            });
        }
        else if (data === 'check_pending_payment') {
            await handlePendingPayment(bot, chatId, messageId);
        }
        else if (data === 'tutorial') {
            await handleTutorial(bot, chatId, messageId);
        }
        else if (data === 'faq') {
            await handleFAQ(bot, chatId, messageId);
        }
        else if (data === 'providers') {
            await handleProviders(bot, chatId, messageId);
        }

        // ================= Renter / Sewa Bot =================
        else if (data === 'renter_main_choice') {
            sessionManager.clearAllSessions(chatId);
            await renterHandler.showStartChoice(bot, chatId, messageId, query.from.first_name || 'User');
        }
        else if (data === 'renter_user_menu') {
            sessionManager.clearAllSessions(chatId);
            await editUserMenu(chatId, messageId, query.from.first_name || 'User');
        }
        else if (data === 'renter_menu') {
            await renterHandler.showRenterMenu(bot, chatId, messageId);
        }
        else if (data.startsWith('rent_buy:')) {
            // Support both legacy (rent_buy:daily) and tier-aware (rent_buy:basic:daily).
            const parts = data.split(':');
            const uname = query.from.username || null;
            if (parts.length >= 3) {
                // rent_buy:<tier>:<plan>
                await renterHandler.startRentPurchase(bot, chatId, messageId, parts[2], parts[1], uname);
            } else {
                // Legacy: default to basic tier.
                await renterHandler.startRentPurchase(bot, chatId, messageId, parts[1], 'basic', uname);
            }
        }
        else if (data === 'renter_upgrade_premium') {
            await renterHandler.showUpgradeOffer(bot, chatId, messageId);
        }

        // ============================================================
        // Premium Renter: Cloud9 install (manual) + Buat Cloud9 (auto)
        // ============================================================
        else if (data === 'renter_c9_install') {
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.startManualInstall(bot, chatId, messageId, 'c9', sessionManager);
            }
        }
        else if (data === 'renter_c9_create') {
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.startCreate(bot, chatId, messageId, 'c9', sessionManager);
            }
        }
        else if (data.startsWith('renter_c9_api:')) {
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.pickRegion(bot, chatId, messageId, 'c9', Number(data.split(':')[1]), sessionManager);
            }
        }
        else if (data.startsWith('renter_c9_regionpick:')) {
            const p = data.split(':');
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.pickSize(bot, chatId, messageId, 'c9', Number(p[1]), cbResolve(p[2]), sessionManager, 0);
            }
        }
        else if (data.startsWith('renter_c9_sizepage:')) {
            const p = data.split(':');
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.pickSize(bot, chatId, messageId, 'c9', Number(p[1]), cbResolve(p[2]), sessionManager, Number(p[3] || 0));
            }
        }
        else if (data.startsWith('renter_c9_sizepick:')) {
            const p = data.split(':');
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.create(bot, chatId, messageId, 'c9', Number(p[1]), cbResolve(p[2]), cbResolve(p[3]));
            }
        }

        // ============================================================
        // Premium Renter: Fastpanel install (manual) + Buat Fastpanel
        // ============================================================
        else if (data === 'renter_fp_install') {
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.startManualInstall(bot, chatId, messageId, 'fp', sessionManager);
            }
        }
        else if (data === 'renter_fp_create') {
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.startCreate(bot, chatId, messageId, 'fp', sessionManager);
            }
        }
        else if (data.startsWith('renter_fp_api:')) {
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.pickRegion(bot, chatId, messageId, 'fp', Number(data.split(':')[1]), sessionManager);
            }
        }
        else if (data.startsWith('renter_fp_regionpick:')) {
            const p = data.split(':');
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.pickSize(bot, chatId, messageId, 'fp', Number(p[1]), cbResolve(p[2]), sessionManager, 0);
            }
        }
        else if (data.startsWith('renter_fp_sizepage:')) {
            const p = data.split(':');
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.pickSize(bot, chatId, messageId, 'fp', Number(p[1]), cbResolve(p[2]), sessionManager, Number(p[3] || 0));
            }
        }
        else if (data.startsWith('renter_fp_sizepick:')) {
            const p = data.split(':');
            if (await renterHandler.requirePremiumRenter(bot, chatId, messageId)) {
                await renterPremiumHandler.create(bot, chatId, messageId, 'fp', Number(p[1]), cbResolve(p[2]), cbResolve(p[3]));
            }
        }
        else if (data.startsWith('rent_pay_refresh:')) {
            await renterHandler.refreshRentPayment(bot, chatId, messageId, data.split(':')[1]);
        }
        else if (data.startsWith('rent_pay_cancel:')) {
            await renterHandler.cancelRentPayment(bot, chatId, messageId, data.split(':')[1]);
        }
        else if (data === 'renter_install_rdp') {
            await handleInstallDedicatedRDP(bot, chatId, messageId, sessionManager, { freeForRenter: true });
        }
        else if (data === 'renter_api_menu') {
            await renterHandler.showApiMenu(bot, chatId, messageId);
        }
        else if (data === 'renter_api_add') {
            await renterHandler.promptAddApi(bot, chatId, messageId, sessionManager, 'digitalocean');
        }
        else if (data === 'renter_api_add_linode') {
            await renterHandler.promptAddApi(bot, chatId, messageId, sessionManager, 'linode');
        }
        else if (data === 'renter_api_add_aws') {
            await renterHandler.promptAddApi(bot, chatId, messageId, sessionManager, 'aws');
        }
        else if (data === 'renter_api_add_upcloud') {
            await renterHandler.promptAddApi(bot, chatId, messageId, sessionManager, 'upcloud');
        }
        else if (data === 'renter_api_delete_menu') {
            await renterHandler.showApiPick(bot, chatId, messageId, 'delete');
        }
        else if (data === 'renter_api_disable_menu') {
            await renterHandler.showApiPick(bot, chatId, messageId, 'disable');
        }
        else if (data.startsWith('renter_api_delete:')) {
            await renterHandler.deleteApi(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data.startsWith('renter_api_disable:')) {
            await renterHandler.disableApi(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data === 'renter_info') {
            await renterHandler.showInfo(bot, chatId, messageId);
        }
        else if (data === 'renter_backup_now') {
            await renterHandler.backupNow(bot, chatId, messageId);
        }
        else if (data === 'renter_restore_prompt') {
            await renterHandler.promptRestore(bot, chatId, messageId, sessionManager);
        }
        else if (data === 'renter_cancel_restore') {
            await renterHandler.cancelRestore(bot, chatId, messageId, sessionManager);
        }
        else if (data === 'renter_services') {
            await renterHandler.showServices(bot, chatId, messageId);
        }
        else if (data.startsWith('renter_srv_view:')) {
            await renterHandler.viewService(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data.startsWith('renter_view_rdp_pass:')) {
            await renterHandler.showRenterRdpPassword(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data.startsWith('renter_srv_confirm:')) {
            const parts = data.split(':');
            await renterHandler.confirmService(bot, chatId, messageId, parts[1], Number(parts[2]));
        }
        else if (data.startsWith('renter_srv_pickwin:')) {
            const parts = data.split(':');
            await renterHandler.pickWindowsForService(bot, chatId, messageId, parts[1], Number(parts[2]));
        }
        else if (data.startsWith('renter_srv_execwin:')) {
            const parts = data.split(':');
            await renterHandler.executeService(bot, chatId, messageId, parts[1], Number(parts[2]), Number(parts[3]));
        }
        else if (data.startsWith('renter_srv_exec:')) {
            const parts = data.split(':');
            await renterHandler.executeService(bot, chatId, messageId, parts[1], Number(parts[2]));
        }
        else if (data === 'renter_vps_start') {
            await renterHandler.startCreate(bot, chatId, messageId, 'vps', sessionManager);
        }
        else if (data === 'renter_rdp_start') {
            await renterHandler.startCreate(bot, chatId, messageId, 'rdp', sessionManager);
        }
        else if (data.startsWith('renter_vps_api:')) {
            await renterHandler.pickApi(bot, chatId, messageId, 'vps', Number(data.split(':')[1]), sessionManager);
        }
        else if (data.startsWith('renter_rdp_api:')) {
            await renterHandler.pickApi(bot, chatId, messageId, 'rdp', Number(data.split(':')[1]), sessionManager);
        }
        else if (data.startsWith('renter_vps_sizepage:')) {
            const parts = data.split(':');
            await renterHandler.pickRegionFirst(bot, chatId, messageId, 'vps', Number(parts[1]), cbResolve(parts[2]), sessionManager, Number(parts[3] || 0));
        }
        else if (data.startsWith('renter_rdp_sizepage:')) {
            const parts = data.split(':');
            await renterHandler.pickRegionFirst(bot, chatId, messageId, 'rdp', Number(parts[1]), cbResolve(parts[2]), sessionManager, Number(parts[3] || 0));
        }
        else if (data.startsWith('renter_vps_regionpick:')) {
            const parts = data.split(':');
            await renterHandler.pickRegionFirst(bot, chatId, messageId, 'vps', Number(parts[1]), cbResolve(parts[2]), sessionManager);
        }
        else if (data.startsWith('renter_rdp_regionpick:')) {
            const parts = data.split(':');
            await renterHandler.pickRegionFirst(bot, chatId, messageId, 'rdp', Number(parts[1]), cbResolve(parts[2]), sessionManager);
        }
        else if (data.startsWith('renter_vps_sizepick:')) {
            const parts = data.split(':');
            await renterHandler.pickSize(bot, chatId, messageId, 'vps', Number(parts[1]), cbResolve(parts[2]), cbResolve(parts[3]), sessionManager);
        }
        else if (data.startsWith('renter_rdp_sizepick:')) {
            const parts = data.split(':');
            await renterHandler.pickSize(bot, chatId, messageId, 'rdp', Number(parts[1]), cbResolve(parts[2]), cbResolve(parts[3]), sessionManager);
        }
        else if (data.startsWith('renter_vps_size:')) {
            const parts = data.split(':');
            await renterHandler.pickSize(bot, chatId, messageId, 'vps', Number(parts[1]), cbResolve(parts[3]), cbResolve(parts[2]), sessionManager);
        }
        else if (data.startsWith('renter_rdp_size:')) {
            const parts = data.split(':');
            await renterHandler.pickSize(bot, chatId, messageId, 'rdp', Number(parts[1]), cbResolve(parts[3]), cbResolve(parts[2]), sessionManager);
        }
        else if (data.startsWith('renter_vps_region:')) {
            const parts = data.split(':');
            await renterHandler.pickRegion(bot, chatId, messageId, 'vps', Number(parts[1]), cbResolve(parts[2]), cbResolve(parts[3]), sessionManager);
        }
        else if (data.startsWith('renter_rdp_region:')) {
            const parts = data.split(':');
            await renterHandler.pickRegion(bot, chatId, messageId, 'rdp', Number(parts[1]), cbResolve(parts[2]), cbResolve(parts[3]), sessionManager);
        }
        else if (data.startsWith('renter_vps_image:')) {
            const parts = data.split(':');
            await renterHandler.createVps(bot, chatId, messageId, Number(parts[1]), cbResolve(parts[3]), cbResolve(parts[2]), cbResolve(parts.slice(4).join(':')));
        }
        else if (data.startsWith('renter_rdp_win:')) {
            const parts = data.split(':');
            await renterHandler.createRdp(bot, chatId, messageId, Number(parts[1]), cbResolve(parts[3]), cbResolve(parts[2]), Number(parts[4]));
        }
        else if (data === 'admin_renter_menu') {
            if (isAdmin(chatId)) await renterHandler.showAdminMenu(bot, chatId, messageId);
        }
        else if (data === 'admin_renter_add') {
            if (isAdmin(chatId)) await renterHandler.promptAdminAdd(bot, chatId, messageId, sessionManager);
        }
        else if (data === 'admin_renter_remove') {
            if (isAdmin(chatId)) await renterHandler.promptAdminRemove(bot, chatId, messageId, sessionManager);
        }
        else if (data === 'admin_renter_list') {
            if (isAdmin(chatId)) await renterHandler.adminList(bot, chatId, messageId);
        }
        else if (data === 'admin_renter_price') {
            // Tier picker (basic vs premium) shown first.
            if (isAdmin(chatId)) await renterHandler.showAdminPriceTierMenu(bot, chatId, messageId);
        }
        else if (data === 'admin_renter_price_basic') {
            if (isAdmin(chatId)) await renterHandler.promptAdminSetPrice(bot, chatId, messageId, sessionManager, 'basic');
        }
        else if (data === 'admin_renter_price_premium') {
            if (isAdmin(chatId)) await renterHandler.promptAdminSetPrice(bot, chatId, messageId, sessionManager, 'premium');
        }

        // ================= Auto Order / Shop =================
        else if (data === 'shop_menu') {
            await shopHandler.showShopMenu(bot, chatId, messageId);
        }
        else if (data === 'shop_list') {
            await shopHandler.listProducts(bot, chatId, messageId);
        }
        else if (data.startsWith('shop_prod_')) {
            const code = data.replace('shop_prod_', '');
            await shopHandler.showProduct(bot, chatId, messageId, code);
        }
        else if (data.startsWith('shop_buy_')) {
            const code = data.replace('shop_buy_', '');
            await shopHandler.startBuy(bot, chatId, messageId, code, sessionManager);
        }
        else if (data.startsWith('shop_refresh_')) {
            const orderId = parseInt(data.replace('shop_refresh_', ''), 10);
            if (!isNaN(orderId)) {
                await shopHandler.refreshShopPayment(bot, chatId, messageId, orderId);
            }
        }
        else if (data.startsWith('shop_cancel_')) {
    const orderId = parseInt(data.replace('shop_cancel_', ''), 10);
    if (!isNaN(orderId)) {
        await shopHandler.cancelShopPayment(bot, chatId, messageId, orderId);
    }
}

// ================= Shop Admin =================
else if (data === 'shop_admin_menu') {
    await shopHandler.showShopAdminMenu(bot, chatId, messageId);
}
else if (data === 'shop_admin_add_product') {
    await shopHandler.adminStartAddProduct(bot, chatId, messageId, sessionManager);
}
else if (data === 'shop_admin_list_products') {
    await shopHandler.adminListProducts(bot, chatId, messageId);
}
else if (data === 'shop_admin_del_product') {
    await shopHandler.adminPromptDeleteProduct(bot, chatId, messageId);
}
else if (data.startsWith('shop_admin_delprod_yes_')) {
    const code = data.replace('shop_admin_delprod_yes_', '');
    await shopHandler.adminDoDeleteProduct(bot, chatId, messageId, code);
}
else if (data.startsWith('shop_admin_delprod_')) {
    const code = data.replace('shop_admin_delprod_', '');
    await shopHandler.adminConfirmDeleteProduct(bot, chatId, messageId, code);
}
else if (data === 'shop_admin_pick_price') {
    await shopHandler.adminPickProduct(bot, chatId, messageId, '💲 *Pilih produk untuk ubah harga*', 'shop_admin_setprice_');
}
else if (data.startsWith('shop_admin_setprice_')) {
    const code = data.replace('shop_admin_setprice_', '');
    await shopHandler.adminStartSetPrice(bot, chatId, messageId, code, sessionManager);
}
else if (data === 'shop_admin_pick_desc') {
    await shopHandler.adminPickProduct(bot, chatId, messageId, '📝 *Pilih produk untuk set keterangan*', 'shop_admin_setdesc_');
}
else if (data.startsWith('shop_admin_setdesc_')) {
    const code = data.replace('shop_admin_setdesc_', '');
    await shopHandler.adminStartSetDesc(bot, chatId, messageId, code, sessionManager);
}
else if (data === 'shop_admin_pick_add_stock') {
    await shopHandler.adminPickProduct(bot, chatId, messageId, '➕ *Pilih produk untuk tambah stok*', 'shop_admin_addstock_');
}
else if (data.startsWith('shop_admin_addstock_')) {
    const code = data.replace('shop_admin_addstock_', '');
    await shopHandler.adminStartAddStock(bot, chatId, messageId, code, sessionManager);
}
else if (data === 'shop_admin_pick_del_stock') {
    await shopHandler.adminPickProduct(bot, chatId, messageId, '🗑️ *Pilih produk untuk hapus stok*', 'shop_admin_delstock_');
}
else if (data.startsWith('shop_admin_delstock_')) {
    const code = data.replace('shop_admin_delstock_', '');
    await shopHandler.adminStartDelStock(bot, chatId, messageId, code, sessionManager);
}
else if (data === 'shop_admin_set_fee') {
    await shopHandler.adminStartSetFee(bot, chatId, messageId, sessionManager);
}

else if (data === 'vps_rdp_menu') {
            await safeMessageEditor.editMessage(bot, chatId, messageId,
                '🖥️ *VPS & RDP*\n\nPilih layanan yang ingin kamu pesan:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🖥️ ORDER VPS', callback_data: 'order_vps' }],
                            [{ text: '🖥️ ORDER RDP', callback_data: 'order_rdp' }],
                            [{ text: '🖥️ VPS&RDP Saya', callback_data: 'my_services' }],
                            [{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]
                        ]
                    }
                }
            );
        }
else if (data === 'order_vps') {
            await vpsOrder.showProducts(bot, chatId, messageId);
        }
        else if (data === 'order_rdp') {
            await rdpOrder.showProducts(bot, chatId, messageId);
        }
        else if (data === 'my_services') {
            await vpsOrder.showMyServices(bot, chatId, messageId);
        }

else if (data.startsWith('srv_view:')) {
    const id = parseInt(data.split(':')[1], 10);
    await vpsOrder.viewMyService(bot, chatId, messageId, id);
}
else if (data.startsWith('srv_action:')) {
    const parts = data.split(':');
    const action = parts[1];
    const id = parseInt(parts[2], 10);
    await vpsOrder.confirmServiceAction(bot, chatId, messageId, action, id);
}
else if (data.startsWith('srv_confirm:')) {
    const parts = data.split(':');
    const action = parts[1];
    const id = parseInt(parts[2], 10);
    await vpsOrder.executeServiceAction(bot, chatId, messageId, action, id);
}
else if (data.startsWith('srv_pickos:')) {
    const parts = data.split(':');
    const action = parts[1];
    const id = parseInt(parts[2], 10);
    await vpsOrder.showRdpWindowsPicker(bot, chatId, messageId, action, id);
}
else if (data.startsWith('srv_confirmos:')) {
    const parts = data.split(':');
    const action = parts[1];
    const id = parseInt(parts[2], 10);
    const osVersion = parts.slice(3).join(':');
    // NEW: show password-mode picker before executing. Was:
    //   await vpsOrder.executeServiceAction(bot, chatId, messageId, action, id, { osVersion });
    await vpsOrder.askRdpPasswordMode(bot, chatId, messageId, action, id, osVersion);
}
else if (data.startsWith('srv_pass_auto:')) {
    const parts = data.split(':');
    const action = parts[1];
    const id = parseInt(parts[2], 10);
    const osVersion = parts.slice(3).join(':');
    await vpsOrder.executeServiceAction(bot, chatId, messageId, action, id, { osVersion });
}
else if (data.startsWith('srv_pass_custom:')) {
    const parts = data.split(':');
    const action = parts[1];
    const id = parseInt(parts[2], 10);
    const osVersion = parts.slice(3).join(':');
    await vpsOrder.startCustomPasswordInput(bot, chatId, messageId, action, id, osVersion, sessionManager);
}
else if (data.startsWith('view_rdp_pass:')) {
    const id = parseInt(data.split(':')[1], 10);
    await vpsOrder.showRdpPassword(bot, chatId, messageId, id);
}

else if (data.startsWith('backup_menu:')) {
    const id = parseInt(data.split(':')[1], 10);
    await backupHandler.showBackupMenu(bot, chatId, messageId, id);
}
else if (data.startsWith('backup_now:')) {
    const id = parseInt(data.split(':')[1], 10);
    await backupHandler.runBackupNow(bot, chatId, messageId, id);
}
else if (data.startsWith('backup_download:')) {
    const id = parseInt(data.split(':')[1], 10);
    await backupHandler.downloadBackup(bot, chatId, messageId, id);
}
else if (data.startsWith('backup_restore_ask:')) {
    const id = parseInt(data.split(':')[1], 10);
    await backupHandler.askRestore(bot, chatId, messageId, id);
}
else if (data.startsWith('backup_restore:')) {
    const id = parseInt(data.split(':')[1], 10);
    await backupHandler.restoreBackup(bot, chatId, messageId, id);
}
else if (data.startsWith('backup_toggle:')) {
    const parts = data.split(':');
    await backupHandler.toggleAuto(bot, chatId, messageId, parseInt(parts[1], 10), parseInt(parts[2], 10));
}
else if (data.startsWith('backup_delete:')) {
    const id = parseInt(data.split(':')[1], 10);
    await backupHandler.deleteBackup(bot, chatId, messageId, id);
}

        else if (data === 'cloud9_menu') {
            await cloud9Handler.showCloud9Menu(bot, chatId, messageId);
        }
        else if (data === 'cloud9_install') {
            await cloud9Handler.startManualInstall(bot, chatId, messageId, sessionManager);
        }
        else if (data === 'cloud9_order') {
            await cloud9Handler.showOrder(bot, chatId, messageId);
        }
        else if (data.startsWith('cloud9_pick:')) {
            await cloud9Handler.pickDuration(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data.startsWith('cloud9_buy:')) {
            const parts = data.split(':');
            await cloud9Handler.orderCloud9(bot, chatId, messageId, Number(parts[1]), Number(parts[2] || 30));
        }
        else if (data === 'cloud9_admin') {
            await cloud9Handler.showAdminMenu(bot, chatId, messageId);
        }
        else if (data === 'cloud9_admin_add') {
            await cloud9Handler.pickAwsApi(bot, chatId, messageId);
        }
        else if (data.startsWith('cloud9_add_api:')) {
            await cloud9Handler.pickSize(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data.startsWith('cloud9_add_sizepage:')) {
            const parts = data.split(':');
            await cloud9Handler.pickSize(bot, chatId, messageId, Number(parts[1]), Number(parts[2] || 0));
        }
        else if (data.startsWith('cloud9_add_size:')) {
            const parts = data.split(':');
            await cloud9Handler.promptAddPriceStock(bot, chatId, messageId, sessionManager, Number(parts[1]), parts[2], Number(parts[3]), Number(parts[4]));
        }
        else if (data === 'cloud9_admin_list') {
            await cloud9Handler.listSpecs(bot, chatId, messageId, 'list');
        }
        else if (data === 'cloud9_admin_price') {
            await cloud9Handler.listSpecs(bot, chatId, messageId, 'price');
        }
        else if (data.startsWith('cloud9_price_pick:')) {
            await cloud9Handler.promptSetPrice(bot, chatId, messageId, sessionManager, Number(data.split(':')[1]));
        }
        else if (data === 'cloud9_admin_delete_instance') {
            await cloud9Handler.listActiveCloud9Instances(bot, chatId, messageId);
        }
        else if (data.startsWith('cloud9_del_inst:')) {
            await cloud9Handler.deleteActiveCloud9(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data === 'cloud9_admin_delete') {
            await cloud9Handler.listSpecs(bot, chatId, messageId, 'delete');
        }
        else if (data.startsWith('cloud9_delete_pick:')) {
            await cloud9Handler.deleteSpec(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data === 'cloud9_admin_stock') {
            await cloud9Handler.listSpecs(bot, chatId, messageId, 'stock');
        }
        else if (data.startsWith('cloud9_stock_pick:')) {
            await cloud9Handler.deleteStock(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data.startsWith('cloud9_stock_do:')) {
            const parts = data.split(':');
            await cloud9Handler.deleteStockDuration(bot, chatId, messageId, Number(parts[1]), Number(parts[2] || 30));
        }

        // ================= Fastpanel =================
        else if (data === 'fastpanel_menu') {
            await fastpanelHandler.showFastpanelMenu(bot, chatId, messageId);
        }
        else if (data === 'fastpanel_install') {
            await fastpanelHandler.startManualInstall(bot, chatId, messageId, sessionManager);
        }
        else if (data === 'fastpanel_order') {
            await fastpanelHandler.showOrder(bot, chatId, messageId);
        }
        else if (data.startsWith('fastpanel_pick:')) {
            await fastpanelHandler.pickDuration(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data.startsWith('fastpanel_buy:')) {
            const parts = data.split(':');
            await fastpanelHandler.orderFastpanel(bot, chatId, messageId, Number(parts[1]), Number(parts[2] || 30));
        }
        else if (data === 'fastpanel_admin') {
            await fastpanelHandler.showAdminMenu(bot, chatId, messageId);
        }
        else if (data === 'fastpanel_admin_add') {
            await fastpanelHandler.pickApi(bot, chatId, messageId);
        }
        else if (data.startsWith('fastpanel_add_api:')) {
            await fastpanelHandler.pickSize(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data.startsWith('fastpanel_add_sizepage:')) {
            const parts = data.split(':');
            await fastpanelHandler.pickSize(bot, chatId, messageId, Number(parts[1]), Number(parts[2] || 0));
        }
        else if (data.startsWith('fastpanel_add_size:')) {
            const parts = data.split(':');
            await fastpanelHandler.promptAddPriceStock(bot, chatId, messageId, sessionManager, Number(parts[1]), parts[2], Number(parts[3]), Number(parts[4]));
        }
        else if (data === 'fastpanel_admin_list') {
            await fastpanelHandler.listSpecs(bot, chatId, messageId, 'list');
        }
        else if (data === 'fastpanel_admin_price') {
            await fastpanelHandler.listSpecs(bot, chatId, messageId, 'price');
        }
        else if (data.startsWith('fastpanel_price_pick:')) {
            await fastpanelHandler.promptSetPrice(bot, chatId, messageId, sessionManager, Number(data.split(':')[1]));
        }
        else if (data === 'fastpanel_admin_delete_instance') {
            await fastpanelHandler.listActiveFastpanelInstances(bot, chatId, messageId);
        }
        else if (data.startsWith('fastpanel_del_inst:')) {
            await fastpanelHandler.deleteActiveFastpanel(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data === 'fastpanel_admin_delete') {
            await fastpanelHandler.listSpecs(bot, chatId, messageId, 'delete');
        }
        else if (data.startsWith('fastpanel_delete_pick:')) {
            await fastpanelHandler.deleteSpec(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data === 'fastpanel_admin_stock') {
            await fastpanelHandler.listSpecs(bot, chatId, messageId, 'stock');
        }
        else if (data.startsWith('fastpanel_stock_pick:')) {
            await fastpanelHandler.deleteStock(bot, chatId, messageId, Number(data.split(':')[1]));
        }
        else if (data.startsWith('fastpanel_stock_do:')) {
            const parts = data.split(':');
            await fastpanelHandler.deleteStockDuration(bot, chatId, messageId, Number(parts[1]), Number(parts[2] || 30));
        }
        else if (data === 'fastpanel_admin_install_price') {
            await fastpanelHandler.promptSetInstallPrice(bot, chatId, messageId, sessionManager);
        }

        else if (data === 'check_balance') {
            const balance = await getBalance(chatId);
            await safeMessageEditor.editMessage(
                bot,
                chatId,
                messageId,
                `👛 *SALDO KAMU*\n\n🆔 ID User: \`${chatId}\`\n💰 Saldo: ${typeof balance === 'string' ? balance : `Rp ${balance.toLocaleString()}`}`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]] }
                }
            );
        }
        else if (data === 'vps_admin') {
            await vpsAdmin.showVpsAdminMenu(bot, chatId, messageId);
        }
        else if (data === 'vps_admin_add_api') {
            if (isAdmin(chatId)) {
                await safeMessageEditor.editMessage(bot, chatId, messageId, 'Masukkan API Token DigitalOcean:', {
                    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin' }]] }
                });
                sessionManager.setAdminSession(chatId, { action: 'vps_add_api', messageId });
            }
        }
        else if (data === 'vps_admin_add_linode_api') {
            if (isAdmin(chatId)) {
                await safeMessageEditor.editMessage(bot, chatId, messageId, 'Masukkan API Token Linode:', {
                    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin' }]] }
                });
                sessionManager.setAdminSession(chatId, { action: 'vps_add_linode_api', messageId });
            }
        }
        else if (data === 'vps_admin_add_aws_api') {
            if (isAdmin(chatId)) {
                await safeMessageEditor.editMessage(bot, chatId, messageId, `Masukkan API AWS dengan format:
\`ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION\`

Contoh region: \`us-east-1\`, \`ap-southeast-1\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin' }]] }
                });
                sessionManager.setAdminSession(chatId, { action: 'vps_add_aws_api', messageId });
            }
        }
        else if (data === 'vps_admin_add_upcloud_api') {
            if (isAdmin(chatId)) {
                await safeMessageEditor.editMessage(bot, chatId, messageId, `Masukkan API Token UpCloud (format \`ucat_xxxx\`):

Buat token di https://hub.upcloud.com/account/api-tokens
Set *allowed_ips* = \`0.0.0.0/0\` (atau IP VPS bot) supaya request bot bisa diterima.`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin' }]] }
                });
                sessionManager.setAdminSession(chatId, { action: 'vps_add_upcloud_api', messageId });
            }
        }
        else if (data === 'vps_admin_disable_api') {
            await vpsAdmin.showDisableApiMenu(bot, chatId, messageId);
        }
        else if (data === 'vps_admin_del_api') {
            await vpsAdmin.showDelApiMenu(bot, chatId, messageId);
        }
        else if (data === 'vps_admin_add_prod_vps') {
            await vpsAdmin.pickProviderForAddProduct(bot, chatId, messageId, 'vps');
        }
        else if (data === 'vps_admin_add_prod_rdp') {
            await vpsAdmin.pickProviderForAddProduct(bot, chatId, messageId, 'rdp');
        }
        else if (data === 'vps_admin_add_prod_combo') {
            await vpsAdmin.pickProviderForAddProduct(bot, chatId, messageId, 'combo');
        }
        else if (data.startsWith('vps_prod_provider:')) {
            const parts = data.split(':');
            await vpsAdmin.pickApiForAddProduct(bot, chatId, messageId, parts[1] || 'vps', parts[2] || 'all');
        }
        else if (data === 'vps_admin_del_vps') {
            await vpsAdmin.showDelVpsByApiMenu(bot, chatId, messageId);
        }
        else if (data === 'vps_admin_list_services' || data.startsWith('vps_admin_list_services:')) {
            const page = data.includes(':') ? Number(data.split(':')[1] || 0) : 0;
            await vpsAdmin.showAdminServiceList(bot, chatId, messageId, page);
        }
        else if (data.startsWith('vps_admin_list_api:')) {
            // Format: vps_admin_list_api:<apiId>[:<page>]
            const parts = data.split(':');
            const apiId = parts[1];
            const page = Number(parts[2] || 0);
            await vpsAdmin.showAdminServiceListByApi(bot, chatId, messageId, apiId, page);
        }
        else if (data === 'vps_admin_check_do') {
            await vpsAdmin.showDoStatusMenu(bot, chatId, messageId);
        }
        else if (data === 'vps_do_status_all') {
            await vpsAdmin.showAllDoStatus(bot, chatId, messageId);
        }
        else if (data.startsWith('vps_do_status:')) {
            const apiId = Number(data.split(':')[1]);
            await vpsAdmin.showDoStatus(bot, chatId, messageId, apiId);
        }
        else if (data === 'vps_admin_backup_menu' || data.startsWith('vps_admin_backup_menu:')) {
            const page = data.includes(':') ? Number(data.split(':')[1] || 0) : 0;
            await vpsAdmin.showAdminBackupServiceList(bot, chatId, messageId, page);
        }
        else if (data === 'vps_admin_power_menu' || data.startsWith('vps_admin_power_menu:')) {
            const page = data.includes(':') ? Number(data.split(':')[1] || 0) : 0;
            await vpsAdmin.showPowerServiceList(bot, chatId, messageId, page);
        }
        else if (data.startsWith('vps_power_pick:')) {
            const parts = data.split(':');
            await vpsAdmin.showPowerActionMenu(bot, chatId, messageId, parts[1], Number(parts[2]));
        }
        else if (data.startsWith('vps_power_do:')) {
            const parts = data.split(':');
            await vpsAdmin.executePowerAction(bot, chatId, messageId, parts[1], Number(parts[2]), parts[3]);
        }
        else if (data === 'vps_admin_stock_provider') {
            await vpsAdmin.showProviderFilterMenu(bot, chatId, messageId, 'stock');
        }
        else if (data === 'vps_admin_stock') {
            await vpsAdmin.showProviderFilterMenu(bot, chatId, messageId, 'stock');
        }
        else if (data.startsWith('vps_stock_provider:')) {
            const provider = data.split(':')[1] || 'all';
            await vpsAdmin.showStockTypeMenu(bot, chatId, messageId, provider);
        }
        else if (data.startsWith('vps_stock_group:')) {
            // vps_stock_group:provider:productType:durationDays:page
            const parts = data.split(':');
            const provider = parts[1] || 'all';
            const productType = parts[2] || 'vps';
            const durationDays = Number(parts[3] || 30);
            const page = Number(parts[4] || 0);
            await vpsAdmin.showStockGroupMenu(bot, chatId, messageId, productType, durationDays, page, provider);
        }
        else if (data.startsWith('vps_stock_api:')) {
            // vps_stock_api:provider:productType:durationDays:ram:core
            const parts = data.split(':');
            const provider = parts[1] || 'all';
            const productType = parts[2] || 'vps';
            const durationDays = Number(parts[3] || 30);
            const ram = Number(parts[4]);
            const core = Number(parts[5]);
            await vpsAdmin.showStockApiMenu(bot, chatId, messageId, productType, durationDays, ram, core, provider);
        }
        else if (data.startsWith('vps_stock_dec:')) {
            // vps_stock_dec:productId:provider:productType:durationDays:ram:core
            const parts = data.split(':');
            const productId = Number(parts[1]);
            const provider = parts[2] || 'all';
            const productType = parts[3] || 'vps';
            const durationDays = Number(parts[4] || 30);
            const ram = Number(parts[5]);
            const core = Number(parts[6]);
            const { decrementProductSlotDuration } = require('./utils/vpsManager');
            await decrementProductSlotDuration(productId, durationDays);
            await vpsAdmin.showStockApiMenu(bot, chatId, messageId, productType, durationDays, ram, core, provider);
        }
else if (data === 'vps_admin_price_provider') {
            await vpsAdmin.showProviderFilterMenu(bot, chatId, messageId, 'price');
        }
else if (data === 'vps_admin_price') {
            await vpsAdmin.showProviderFilterMenu(bot, chatId, messageId, 'price');
        }
        else if (data.startsWith('vps_price_provider:')) {
            const provider = data.split(':')[1] || 'all';
            await vpsAdmin.showPriceTypeMenu(bot, chatId, messageId, provider);
        }
        else if (data.startsWith('vps_price_type:')) {
            // vps_price_type:provider:productType:page
            const parts = data.split(':');
            const provider = parts[1] || 'all';
            const productType = parts[2] || 'vps';
            const page = Number(parts[3] || 0);
            await vpsAdmin.showPriceSpecMenu(bot, chatId, messageId, productType, page, provider);
        }
        else if (data.startsWith('vps_price_spec:')) {
            // vps_price_spec:provider:productType:ram:core
            const parts = data.split(':');
            const provider = parts[1] || 'all';
            const productType = parts[2] || 'vps';
            const ram = Number(parts[3]);
            const core = Number(parts[4]);

            if (isAdmin(chatId)) {
                await safeMessageEditor.editMessage(bot, chatId, messageId, `Masukkan *HARGA HARIAN*, *HARGA MINGGUAN*, dan *HARGA BULANAN* baru untuk ${productType.toUpperCase()} RAM ${ram}GB / ${core} CORE.\nFormat: \`harian mingguan bulanan\` (angka saja).\nContoh: \`5000 30000 120000\``, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_price' }]] }
                });
                sessionManager.setAdminSession(chatId, { action: 'vps_update_price', provider, productType, ram, core, messageId });
            }
        }
        else if (data === 'vps_admin_install_price') {
            await vpsAdmin.showInstallPriceMenu(bot, chatId, messageId);
        }
        else if (data === 'set_install_rdp_cost') {
            if (isAdmin(chatId)) {
                await safeMessageEditor.editMessage(bot, chatId, messageId, 'Masukkan HARGA baru Install RDP (angka saja):', {
                    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_install_price' }]] }
                });
                sessionManager.setAdminSession(chatId, { action: 'set_install_rdp_cost', messageId });
            }
        }
        else if (data === 'set_dedicated_install_rdp_cost') {
            if (isAdmin(chatId)) {
                await safeMessageEditor.editMessage(bot, chatId, messageId, 'Masukkan HARGA baru Dedicated RDP Installer (angka saja):', {
                    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_install_price' }]] }
                });
                sessionManager.setAdminSession(chatId, { action: 'set_dedicated_install_rdp_cost', messageId });
            }
        }

        else if (data.startsWith('vps_buy:')) {
            const pid = Number(data.split(':')[1]);
            await vpsOrder.pickProduct(bot, chatId, messageId, pid);
        }
        else if (data.startsWith('vps_buygrp:')) {
            const parts = data.split(':');
            const ram = Number(parts[1]);
            const core = Number(parts[2]);
            await vpsOrder.pickProductGroup(bot, chatId, messageId, ram, core);
        }
        else if (data.startsWith('vps_buydur:')) {
            const parts = data.split(':');
            const ram = Number(parts[1]);
            const core = Number(parts[2]);
            const duration = Number(parts[3] || 7);
            await vpsOrder.pickProviderByDuration(bot, chatId, messageId, ram, core, duration);
        }
        else if (data.startsWith('vps_buyprov:')) {
            const parts = data.split(':');
            const ram = Number(parts[1]);
            const core = Number(parts[2]);
            const duration = Number(parts[3] || 7);
            const provider = parts[4] || 'all';
            await vpsOrder.pickProductByProvider(bot, chatId, messageId, ram, core, duration, provider);
        }
        else if (data.startsWith('vps_reg:')) {
            const parts = data.split(':');
            const pid = Number(parts[1]);
            const region = parts[2];
            const duration = Number(parts[3] || 7);
            await vpsOrder.pickRegion(bot, chatId, messageId, pid, region, duration);
        }
        else if (data.startsWith('vps_img:')) {
            const parts = data.split(':');
            const pid = Number(parts[1]);
            const region = parts[2];
            const maybeDur = parts[parts.length - 1];
            const duration = (/^[0-9]+$/.test(maybeDur)) ? Number(maybeDur) : 7;
            const img = (/^[0-9]+$/.test(maybeDur)) ? parts.slice(3, -1).join(':') : parts.slice(3).join(':');
            await vpsOrder.createVps(bot, chatId, messageId, pid, region, img, duration);
        }
        else if (data.startsWith('rdp_buygrp:')) {
            const parts = data.split(':');
            const ram = Number(parts[1]);
            const core = Number(parts[2]);
            await rdpOrder.pickProduct(bot, chatId, messageId, ram, core);
        }
        else if (data.startsWith('rdp_buydur:')) {
            const parts = data.split(':');
            const ram = Number(parts[1]);
            const core = Number(parts[2]);
            const duration = Number(parts[3] || 7);
            await rdpOrder.pickProviderByDuration(bot, chatId, messageId, ram, core, duration);
        }
        else if (data.startsWith('rdp_buyprov:')) {
            const parts = data.split(':');
            const ram = Number(parts[1]);
            const core = Number(parts[2]);
            const duration = Number(parts[3] || 7);
            const provider = parts[4] || 'all';
            await rdpOrder.pickProductByProvider(bot, chatId, messageId, ram, core, duration, provider);
        }
        else if (data.startsWith('rdp_buy:')) {
            const pid = Number(data.split(':')[1]);
            await rdpOrder.pickProductById(bot, chatId, messageId, pid);
        }
        else if (data.startsWith('rdp_reg:')) {
            const parts = data.split(':');
            const pid = Number(parts[1]);
            const region = parts[2];
            const duration = Number(parts[3] || 7);
            await rdpOrder.pickRegion(bot, chatId, messageId, pid, region, duration);
        }
        else if (data.startsWith('rdp_os:')) {
            const parts = data.split(':');
            // Format: rdp_os:productId:region:osId:durationDays
            const pid = Number(parts[1]);
            const region = parts[2];
            const osId = Number(parts[3]);
            const duration = Number(parts[4] || 7);
            // NEW: show password-mode picker before provisioning. Was:
            //   await rdpOrder.createRdp(bot, chatId, messageId, pid, region, osId, duration);
            await rdpOrder.askOrderPasswordMode(bot, chatId, messageId, pid, region, osId, duration);
        }
        else if (data.startsWith('rdp_pass_auto:')) {
            const parts = data.split(':');
            const pid = Number(parts[1]);
            const region = parts[2];
            const osId = Number(parts[3]);
            const duration = Number(parts[4] || 7);
            await rdpOrder.createRdp(bot, chatId, messageId, pid, region, osId, duration);
        }
        else if (data.startsWith('rdp_pass_custom:')) {
            const parts = data.split(':');
            const pid = Number(parts[1]);
            const region = parts[2];
            const osId = Number(parts[3]);
            const duration = Number(parts[4] || 7);
            await rdpOrder.startOrderCustomPasswordInput(bot, chatId, messageId, pid, region, osId, duration, sessionManager);
        }
        else if (data.startsWith('vps_del_req:')) {
            const vpsId = Number(data.split(':')[1]);
            await vpsOrder.deleteMyVps(bot, chatId, messageId, vpsId);
        }
        else if (data.startsWith('vps_delapi:')) {
            const apiId = Number(data.split(':')[1]);
            await vpsAdmin.deleteApi(bot, chatId, messageId, apiId);
        }
        else if (data.startsWith('vps_disableapi:')) {
            const apiId = Number(data.split(':')[1]);
            await vpsAdmin.disableApi(bot, chatId, messageId, apiId);
        }
        else if (data.startsWith('vps_prod_api:')) {
            const parts = data.split(':');
            const productType = parts[1] || 'vps';
            const apiId = Number(parts[2]);
            await vpsAdmin.pickSizeMenu(bot, chatId, messageId, productType, apiId);
        }
        else if (data.startsWith('vps_prod_sizepage:')) {
            const parts = data.split(':');
            const productType = parts[1] || 'vps';
            const apiId = Number(parts[2]);
            const page = Number(parts[3] || 0);
            await vpsAdmin.pickSizeMenu(bot, chatId, messageId, productType, apiId, page);
        }
        else if (data.startsWith('vps_prod_size:')) {
            // vps_prod_size:productType:apiId:sizeSlug:ram:core
            const parts = data.split(':');
            const productType = parts[1] || 'vps';
            const apiId = Number(parts[2]);
            const sizeSlug = parts[3];
            const ram = Number(parts[4]);
            const core = Number(parts[5]);
            if (isAdmin(chatId)) {
                await safeMessageEditor.editMessage(bot, chatId, messageId, 'Masukkan *HARGA HARIAN*, *HARGA MINGGUAN*, dan *HARGA BULANAN* (format: `harian mingguan bulanan`, angka saja).\nContoh: `5000 30000 120000`', {
                    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: `vps_admin_add_prod_${productType}` }]] }
                });
                sessionManager.setAdminSession(chatId, { action: 'vps_add_prod_price', productType, messageId, apiId, sizeSlug, ram, core });
            }
        }
        else if (data.startsWith('vps_delvps_api:')) {
            const apiId = Number(data.split(':')[1]);
            await vpsAdmin.showVpsListForDelete(bot, chatId, messageId, apiId);
        }
        else if (data.startsWith('vps_del_inst:')) {
            // Reuse same delete path as user (admin allowed)
            const vpsId = Number(data.split(':')[1]);
            await vpsOrder.deleteMyVps(bot, chatId, messageId, vpsId);
        }

        else if (data === 'add_balance') {
            if (isAdmin(chatId)) {
                await handleAddBalance(bot, chatId, messageId);
                sessionManager.setAdminSession(chatId, { action: 'add_balance' });
            }
        }
        else if (data === 'broadcast') {
            if (isAdmin(chatId)) {
                await handleBroadcast(bot, chatId, messageId);
                sessionManager.setAdminSession(chatId, { action: 'broadcast' });
            }
        }
        else if (data === 'manage_db') {
            if (isAdmin(chatId)) {
                await dbBackup.handleManageDatabase(chatId, messageId);
            }
        }
        else if (data === 'restore_db') {
            if (isAdmin(chatId)) {
                await dbBackup.promptRestore(chatId, messageId);
                sessionManager.setAdminSession(chatId, { action: 'restore_db_wait' });
            }
        }
        else if (data === 'cancel_restore_db') {
            if (isAdmin(chatId)) {
                sessionManager.clearAdminSession(chatId);
                await safeMessageEditor.editMessage(bot, chatId, messageId, '✅ Restore dibatalkan.', createMainMenu(true));
            }
        }
        else if (data === 'atlantic_admin') {
            if (isAdmin(chatId)) {
                await handleAtlanticAdmin(bot, chatId, messageId);
            }
        }
        else if (data === 'crypto_admin_menu' ||
                 data.startsWith('crypto_admin_set:') ||
                 data.startsWith('crypto_admin_mode:') ||
                 data === 'crypto_admin_refresh_rate') {
            if (isAdmin(chatId)) {
                await cryptoAdminHandler.handleCryptoAdminCallbacks(bot, query, sessionManager);
            }
        }
        else if (data === 'save_account') {
            if (isAdmin(chatId)) {
                await handleSaveAccount(bot, chatId, messageId, sessionManager);
            }
        }
        else if (data === 'cancel_save_account') {
            if (isAdmin(chatId)) {
                sessionManager.clearAccountSession(chatId);
                await bot.editMessageText('Cancelled.', {
                    chat_id: chatId,
                    message_id: messageId
                });
            }
        }
        else if (data === 'backup_now') {
            if (isAdmin(chatId)) {
                await safeMessageEditor.editMessage(bot, chatId, messageId, '📥 Mengirim backup database...');
                await dbBackup.sendBackupToAdmin(chatId);
                await safeMessageEditor.editMessage(bot, chatId, messageId, '✅ Backup database berhasil dikirim!', {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '« Kembali', callback_data: 'back_to_menu' }
                        ]]
                    }
                });
            }
        }
        // Handle copy functionality
        else if (data.startsWith('copy_rdp_')) {

            const payload = data.replace('copy_rdp_', '');
            // payload format: <ip[:port]>_<password>_<hostname>
            const parts = payload.split('_');
            const ip = parts[0] || '-';
            const password = parts[1] || '-';
            const hostname = parts.slice(2).join('_') || '-';
            // ip bisa sudah mengandung :port (UpCloud=3389). Fallback 4443.
            const server = ip.includes(':') ? ip : `${ip}:4443`;

            const detail =
`📋 *Detail RDP (Copy):*\n\n` +
`Hostname: \`${hostname}\`\n` +
`Server: \`${server}\`\n` +
`Username: \`administrator\`\n` +
`Password: \`${password}\``;

            await bot.sendMessage(chatId, detail, { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id).catch(() => {});
            return;
        }
        else if (data.startsWith('copy_server_')) {

            const server = data.replace('copy_server_', '');
            await bot.sendMessage(chatId, `📋 *Server RDP:*
\`${server}\``, { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id).catch(() => {});
            return;
        }
        else if (data.startsWith('copy_pass_')) {

            const password = data.replace('copy_pass_', '');
            await bot.sendMessage(chatId, `📋 *Password:*
\`${password}\``, { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id).catch(() => {});
            return;
        }
        else if (data.startsWith('copy_hostname_')) {

            const hostname = data.replace('copy_hostname_', '');
            await bot.sendMessage(chatId, `📋 *Hostname:*
\`${hostname}\``, { parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id).catch(() => {});
            return;
        }
        
else if (data.startsWith('copy_ip_')) {
    const ip = data.replace('copy_ip_', '');
    const server = ip.includes(':') ? ip : `${ip}:4443`;
    await bot.sendMessage(chatId, `📋 *Server RDP:*\n\`${server}\``, { parse_mode: 'Markdown' });
    bot.answerCallbackQuery(query.id).catch(() => {});
    return;
}
else if (data.startsWith('copy_password_')) {
    const password = data.replace('copy_password_', '');
    await bot.sendMessage(chatId, `📋 *Password:*\n\`${password}\``, { parse_mode: 'Markdown' });
    bot.answerCallbackQuery(query.id).catch(() => {});
    return;
}
else if (data === 'copy_username_administrator' || data.startsWith('copy_username_')) {
    // for backward compatibility
    const username = data === 'copy_username_administrator' ? 'administrator' : data.replace('copy_username_', '');
    await bot.sendMessage(chatId, `📋 *Username:*\n\`${username}\``, { parse_mode: 'Markdown' });
    bot.answerCallbackQuery(query.id).catch(() => {});
    return;
}

        else if (data === 'rdp_connection_guide') {
            const guide =
`📚 Panduan Koneksi RDP

` +
`1. Buka Remote Desktop Connection (mstsc)
` +
`2. Masukkan Server: IP:PORT sesuai detail server kamu
   (UpCloud: port 3389, provider lain: port 4443)
` +
`3. Username: administrator
` +
`4. Password: (password kamu)
` +
`5. Connect dan enjoy!

` +
`Tips: pastikan port RDP kamu tidak diblokir oleh jaringan kamu.`;
            await bot.sendMessage(chatId, guide);
        }
        
else if (data.startsWith('test_rdp_')) {
    const parts = data.split('_');
    const ip = parts[2];
    const port = parts[3];

    try {
        const { RDPMonitor } = require('./utils/rdpMonitor');
        const monitor = new RDPMonitor(ip, '', '', '', parseInt(port));
        const testResult = await monitor.testRDPConnection();

        await bot.sendMessage(chatId,
            `🔎 Test RDP ${ip}:${port}

` +
            `${testResult.success ? '✅ RDP Siap!' : '❌ RDP Belum Siap'}
` +
            `${testResult.message}`
        );
    } catch (error) {
        await bot.sendMessage(chatId, `❌ Error testing RDP: ${error.message}`);
    }
}
        else if (data === 'cancel_payment') {
            // Cancel should work even after the deposit session is gone.
            // We cancel the pending payment record and stop the monitoring loop.
            try {
                const pendingPayment = await PaymentTracker.getPendingPayment(chatId);
                if (pendingPayment) {
                    const { cancelPaymentMonitoring } = require('./utils/paymentStatus');
                    const { cancelPayment } = require('./utils/payment');
                    cancelPaymentMonitoring(pendingPayment.transaction_id);
                    // Fire-and-forget: batalkan invoice di gateway juga supaya tidak menumpuk
                    // sebagai PENDING di dashboard PG-Donn-. Kalau gagal (mis. gateway
                    // DompetX/Pakasir yang belum expose cancel API), abaikan — cukup
                    // biarkan invoice expire alami di sisi PG.
                    cancelPayment(pendingPayment.transaction_id).catch((err) => {
                        console.log('[cancel_payment] cancel gateway invoice warning:', err?.message || err);
                    });
                    await PaymentTracker.removePendingPayment(pendingPayment.transaction_id);
                }
            } catch (e) {
                console.log('Cancel payment cleanup warning:', e.message);
            }

            sessionManager.clearDepositSession(chatId);

            // Remove the QR/photo message so it doesn't "nempel" on chat.
            try { await bot.deleteMessage(chatId, messageId); } catch (_) {}

            await bot.sendMessage(chatId, '❌ Pembayaran dibatalkan.', {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
                    ]
                }
            });
        }
        // TAMBAHAN CODE UNTUK CHECK RDP STATUS
        else if (data.startsWith('check_rdp_')) {
            const [, , ip, port] = data.split('_');
            const RDPMonitor = require('./utils/rdpMonitor');
            
            try {
                await safeMessageEditor.editMessage(bot, chatId, messageId, '🔍 Mengecek status RDP...');

                const monitor = new RDPMonitor(ip, 'root', 'dummy'); // password tidak diperlukan untuk cek port
                const rdpStatus = await monitor.checkRDPPort(parseInt(port));
                monitor.disconnect();

                if (rdpStatus) {
                    await safeMessageEditor.editMessage(bot, chatId, messageId,
                        `✅ **Status RDP: AKTIF**\n\n` +
                        `🌐 Server: ${ip}:${port}\n` +
                        `🔌 Port RDP: Dapat diakses\n` +
                        `🎯 Status: Siap digunakan!\n\n` +
                        `💡 Anda sekarang dapat terhubung ke RDP server.`,
                        {
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: '« Kembali ke Menu', callback_data: 'back_to_menu' }
                                ]]
                            }
                        }
                    );
                } else {
                    await safeMessageEditor.editMessage(bot, chatId, messageId,
                        `⚠️ **Status RDP: BELUM SIAP**\n\n` +
                        `🌐 Server: ${ip}:${port}\n` +
                        `🔌 Port RDP: Tidak dapat diakses\n` +
                        `⏳ Status: Masih booting...\n\n` +
                        `💡 Silakan tunggu 5-10 menit lagi dan coba kembali.`,
                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Cek Lagi', callback_data: `check_rdp_${ip}_${port}` }],
                                    [{ text: '« Kembali ke Menu', callback_data: 'back_to_menu' }]
                                ]
                            }
                        }
                    );
                }
            } catch (error) {
                await safeMessageEditor.editMessage(bot, chatId, messageId,
                    `❌ **Error saat mengecek status RDP**\n\n` +
                    `Error: ${error.message}`,
                    {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '« Kembali ke Menu', callback_data: 'back_to_menu' }
                            ]]
                        }
                    }
                );
            }
        }

        await bot.answerCallbackQuery(query.id).catch(() => {});
    } catch (error) {
        await errorHandler.handleCallbackError(error, query, { data });
    }
});

bot.on('message', async (msg) => {
    if (!msg.document && msg.text && await backupHandler.handleRdpBackupPassword(bot, msg)) {
        return;
    }
    if (msg.document && await backupHandler.handleRestoreUpload(bot, msg)) {
        return;
    }
    const chatId = msg.chat.id;

    if (msg.text && msg.text.startsWith('/')) {
        return;
    }

    // Renter: Restore data renter (upload .json as document)
    const renterSessionForDoc = sessionManager.getAdminSession(chatId);
    if (msg.document && renterSessionForDoc && renterSessionForDoc.action === 'renter_restore_wait') {
        await renterHandler.processRestoreDocument(bot, msg, sessionManager);
        return;
    }

    // Dedicated RDP AWS: accept .pem/.key file as Telegram document
    const dedicatedSessionForPem = sessionManager.getUserSession(chatId);
    if (msg.document && dedicatedSessionForPem && dedicatedSessionForPem.installType === 'dedicated' && dedicatedSessionForPem.step === 'waiting_private_key') {
        const path = require('path');
        const fs = require('fs');
        let filePath = null;
        try {
            const fileName = msg.document.file_name || '';
            const ext = path.extname(fileName).toLowerCase();
            const allowed = ['.pem', '.key', '.txt'];
            if (!allowed.includes(ext)) {
                await bot.sendMessage(chatId, '❌ File tidak valid. Kirim file private key dengan ekstensi .pem, .key, atau .txt.');
                return;
            }
            if (msg.document.file_size && msg.document.file_size > 128 * 1024) {
                await bot.sendMessage(chatId, '❌ File terlalu besar. Pastikan yang dikirim adalah file private key .pem.');
                return;
            }

            const downloadDir = path.join(__dirname, '../tmp/aws-keys');
            if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
            filePath = await bot.downloadFile(msg.document.file_id, downloadDir);
            const privateKey = fs.readFileSync(filePath, 'utf8').trim();

            if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey) || !/-----END [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
                await bot.sendMessage(chatId, '❌ Isi file tidak terlihat seperti private key .pem. Pastikan file berisi BEGIN/END PRIVATE KEY.');
                return;
            }

            const msgWithKey = { ...msg, text: privateKey };
            await handleDedicatedVPSCredentials(bot, msgWithKey, sessionManager);
        } catch (err) {
            console.error('AWS PEM document error:', err);
            await bot.sendMessage(chatId, '❌ Gagal membaca file .pem. Coba kirim ulang sebagai File/Dokumen, bukan foto.');
        } finally {
            if (filePath) {
                try { fs.unlinkSync(filePath); } catch (e) {}
            }
        }
        return;
    }

    // Admin: Restore database (upload .db as document)
    const adminSessionForDoc = sessionManager.getAdminSession(chatId);
    if (msg.document && adminSessionForDoc && adminSessionForDoc.action === 'restore_db_wait' && isAdmin(chatId)) {
        try {
            const path = require('path');
            const fs = require('fs');
            const database = require('./config/database');

            const downloadDir = path.join(__dirname, '../tmp');
            if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

            const filePath = await bot.downloadFile(msg.document.file_id, downloadDir);

            // IMPORTANT: The bot database lives at src/rdp.db (see src/config/database.js)
            const dbPath = path.join(__dirname, 'rdp.db');
            const backupPath = dbPath + '.bak_' + Date.now();

            // Validate SQLite header (avoid overwriting DB with a non-sqlite file)
            try {
                const fd = fs.openSync(filePath, 'r');
                const buf = Buffer.alloc(16);
                fs.readSync(fd, buf, 0, 16, 0);
                fs.closeSync(fd);
                const header = buf.toString('utf8');
                if (!header.startsWith('SQLite format 3')) {
                    throw new Error('Uploaded file is not a valid SQLite database');
                }
            } catch (e) {
                await bot.sendMessage(chatId, '❌ File tidak valid. Pastikan kamu mengirim file backup SQLite (.db) sebagai *Document*.', { parse_mode: 'Markdown' });
                sessionManager.clearAdminSession(chatId);
                return;
            }

            // Backup current DB first
            try {
                if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, backupPath);
            } catch (e) {
                console.error('Backup-before-restore failed:', e);
            }

            // Close DB connection before replacing the file
            try {
                if (database && database.raw && typeof database.raw.close === 'function') {
                    await new Promise((resolve) => database.raw.close(() => resolve()));
                }
            } catch (e) {
                console.warn('DB close before restore failed (continuing):', e?.message || e);
            }

            // Replace DB
            fs.copyFileSync(filePath, dbPath);

            sessionManager.clearAdminSession(chatId);

            const restartMode = selfRestart.scheduleRestart(1500);
            await bot.sendMessage(chatId,
                'Restore berhasil! Bot akan restart otomatis agar database baru terbaca.\n\n' +
                (restartMode === 'pm2'
                    ? 'Mode restart: PM2.'
                    : 'Mode restart: otomatis dari bot. Tidak perlu ketik npm run start lagi.')
            , { parse_mode: 'Markdown' });

        } catch (err) {
            console.error('Restore DB error:', err);
            await bot.sendMessage(chatId, '❌ Gagal restore database. Pastikan file adalah backup SQLite (.db).');
        }
        return;
    }

    // Allow broadcast to copy any message type (photo/video/document/etc)
    const adminSessionAny = sessionManager.getAdminSession(chatId);
    if (adminSessionAny && isAdmin(chatId) && adminSessionAny.action === 'broadcast') {
        await processBroadcast(bot, msg);
        sessionManager.clearAdminSession(chatId);
        return;
    }

    // Ignore non-text messages (except restore flow above)
    if (!msg.text) {
        return;
    }

    try {
        // ================= Auto Order / Shop (qty input) =================
        const shopSession = sessionManager.getShopSession(chatId);
        if (shopSession && shopSession.step === 'waiting_qty') {
            await shopHandler.handleQtyInput(bot, msg, shopSession, sessionManager);
            return;
        }

        const adminSession = sessionManager.getAdminSession(chatId);
        if (adminSession && adminSession.action === 'renter_add_api') {
            await renterHandler.processAddApi(bot, msg, sessionManager);
            return;
        }
        if (adminSession && isAdmin(chatId)) {
            if (adminSession.action === 'admin_renter_add') {
                await renterHandler.processAdminAdd(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'admin_renter_remove') {
                await renterHandler.processAdminRemove(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'admin_renter_price') {
                await renterHandler.processAdminSetPrice(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'cloud9_add_price_stock') {
                await cloud9Handler.processAddPriceStock(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'cloud9_set_price') {
                await cloud9Handler.processSetPrice(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'fastpanel_add_price_stock') {
                await fastpanelHandler.processAddPriceStock(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'fastpanel_set_price') {
                await fastpanelHandler.processSetPrice(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'fastpanel_set_install_price') {
                await fastpanelHandler.processSetInstallPrice(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'add_balance') {
                await processAddBalance(bot, msg);
                sessionManager.clearAdminSession(chatId);
                return;
            } else if (adminSession.action === 'broadcast') {
                await processBroadcast(bot, msg);
                sessionManager.clearAdminSession(chatId);
                return;
            } else if (adminSession.action === 'crypto_admin_set') {
                await cryptoAdminHandler.processCryptoSetting(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'shop_add_product') {
                await shopHandler.processAddProduct(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'shop_set_price') {
                await shopHandler.processSetPrice(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'shop_set_desc') {
                await shopHandler.processSetDesc(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'shop_add_stock') {
                await shopHandler.processAddStock(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'shop_del_stock') {
                await shopHandler.processDelStock(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'shop_set_fee') {
                await shopHandler.processSetFee(bot, msg, sessionManager);
                return;
            } else if (adminSession.action === 'vps_add_api') {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
                const token = String(msg.text || '').trim();
                const waitMsg = await bot.sendMessage(chatId, '⏳ Mengecek dan menyimpan API DigitalOcean...');
                try {
                    const { addDoApiToken } = require('./utils/vpsManager');
                    const res = await addDoApiToken(token);
                    sessionManager.clearAdminSession(chatId);
                    const emailInfo = res?.email ? `
Email: ${res.email}` : '';
                    if (res && res.exists) {
                        if (res.reenabled) {
                            await bot.editMessageText(`✅ API sudah ada (API#${res.apiId}) dan sudah diaktifkan kembali.${emailInfo}

Ketik /start untuk kembali.`, { chat_id: chatId, message_id: waitMsg.message_id });
                        } else {
                            await bot.editMessageText(`ℹ️ API sudah ada (API#${res.apiId}).${emailInfo}

Ketik /start untuk kembali.`, { chat_id: chatId, message_id: waitMsg.message_id });
                        }
                    } else {
                        await bot.editMessageText(`✅ API DigitalOcean berhasil ditambahkan.${emailInfo}

Ketik /start untuk kembali.`, { chat_id: chatId, message_id: waitMsg.message_id });
                    }
                } catch (e) {
                    console.error('Add DigitalOcean API error:', e);
                    sessionManager.clearAdminSession(chatId);
                    await bot.editMessageText(`❌ Gagal menambahkan API DigitalOcean.
Reason: ${e.message || e}

Ketik /start untuk kembali.`, { chat_id: chatId, message_id: waitMsg.message_id });
                }
                return;
            } else if (adminSession.action === 'vps_add_linode_api') {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
                const token = String(msg.text || '').trim();
                const waitMsg = await bot.sendMessage(chatId, '⏳ Mengecek dan menyimpan API Linode...');
                try {
                    const { addLinodeApiToken } = require('./utils/vpsManager');
                    const res = await addLinodeApiToken(token);
                    sessionManager.clearAdminSession(chatId);
                    const emailInfo = res?.email ? `
Email: ${res.email}` : '';
                    await bot.editMessageText(`${res?.exists ? 'ℹ️ API Linode sudah ada' : '✅ API Linode berhasil ditambahkan'} (API#${res.apiId}).${emailInfo}

Ketik /start untuk kembali.`, { chat_id: chatId, message_id: waitMsg.message_id });
                } catch (e) {
                    console.error('Add Linode API error:', e);
                    sessionManager.clearAdminSession(chatId);
                    await bot.editMessageText(`❌ Gagal menambahkan API Linode.
Reason: ${e.message || e}

Pastikan token Linode valid dan memiliki akses Read/Write.`, { chat_id: chatId, message_id: waitMsg.message_id });
                }
                return;
            } else if (adminSession.action === 'vps_add_aws_api') {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
                const token = String(msg.text || '').trim();
                const waitMsg = await bot.sendMessage(chatId, '⏳ Mengecek dan menyimpan API AWS...');
                try {
                    const { addAwsApiToken } = require('./utils/vpsManager');
                    const res = await addAwsApiToken(token);
                    sessionManager.clearAdminSession(chatId);
                    const emailInfo = res?.email ? `
Account/ARN: ${res.email}` : '';
                    await bot.editMessageText(`${res?.exists ? 'ℹ️ API AWS sudah ada' : '✅ API AWS berhasil ditambahkan'} (API#${res.apiId}).${emailInfo}

Ketik /start untuk kembali.`, { chat_id: chatId, message_id: waitMsg.message_id });
                } catch (e) {
                    console.error('Add AWS API error:', e);
                    sessionManager.clearAdminSession(chatId);
                    await bot.editMessageText(`❌ Gagal menambahkan API AWS.
Reason: ${e.message || e}

Format: ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION`, { chat_id: chatId, message_id: waitMsg.message_id });
                }
                return;
            } else if (adminSession.action === 'vps_add_upcloud_api') {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
                const token = String(msg.text || '').trim();
                const waitMsg = await bot.sendMessage(chatId, '⏳ Mengecek dan menyimpan API UpCloud...');
                try {
                    const { addUpCloudApiToken } = require('./utils/vpsManager');
                    const res = await addUpCloudApiToken(token);
                    sessionManager.clearAdminSession(chatId);
                    const emailInfo = res?.email ? `
Account: ${res.email}` : '';
                    await bot.editMessageText(`${res?.exists ? 'ℹ️ API UpCloud sudah ada' : '✅ API UpCloud berhasil ditambahkan'} (API#${res.apiId}).${emailInfo}

Ketik /start untuk kembali.`, { chat_id: chatId, message_id: waitMsg.message_id });
                } catch (e) {
                    console.error('Add UpCloud API error:', e);
                    sessionManager.clearAdminSession(chatId);
                    await bot.editMessageText(`❌ Gagal menambahkan API UpCloud.
Reason: ${e.message || e}

Buat token di https://hub.upcloud.com/account/api-tokens
Set allowed_ips = 0.0.0.0/0 supaya bot bisa akses.`, { chat_id: chatId, message_id: waitMsg.message_id });
                }
                return;
            } else if (adminSession.action === 'vps_add_prod_price') {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
                // Expect: "harian mingguan bulanan" (3 angka), atau "mingguan bulanan" (2 angka), atau "bulanan" (1 angka)
                const parts = String(msg.text || '').trim().split(/\s+/).filter(Boolean);
                if (!parts.length || parts.length > 3 || parts.some(p => !/^[0-9]+$/.test(p))) {
                    await bot.sendMessage(chatId, '❌ Format salah. Masukkan: `harian mingguan bulanan` (angka saja). Contoh: `5000 30000 120000`', { parse_mode: 'Markdown' });
                    return;
                }
                let daily = null, weekly = null, monthly = null;
                if (parts.length === 3) {
                    daily = Number(parts[0]);
                    weekly = Number(parts[1]);
                    monthly = Number(parts[2]);
                } else if (parts.length === 2) {
                    weekly = Number(parts[0]);
                    monthly = Number(parts[1]);
                } else {
                    monthly = Number(parts[0]);
                }

                adminSession.priceDaily = daily;
                adminSession.priceWeekly = weekly;
                adminSession.priceMonthly = monthly;
                adminSession.action = 'vps_add_prod_stock';
                sessionManager.setAdminSession(chatId, adminSession);
                await bot.sendMessage(chatId, 'Masukkan JUMLAH STOK *HARIAN*, *MINGGUAN*, *BULANAN* (format: `harian mingguan bulanan`, angka saja).\nContoh: `5 5 1`', { parse_mode: 'Markdown' });
                return;
            } else if (adminSession.action === 'vps_add_prod_stock') {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
                const parts = String(msg.text || '').trim().split(/\s+/).filter(Boolean);
                if (!parts.length || parts.length > 3 || parts.some(p => !/^[0-9]+$/.test(p))) {
                    await bot.sendMessage(chatId, '❌ Format salah. Masukkan: `harian mingguan bulanan` (angka saja). Contoh: `5 5 1`', { parse_mode: 'Markdown' });
                    return;
                }
                let slotDaily = 0, slotWeekly = 0, slotMonthly = 0;
                if (parts.length === 3) {
                    slotDaily = Number(parts[0]);
                    slotWeekly = Number(parts[1]);
                    slotMonthly = Number(parts[2]);
                } else if (parts.length === 2) {
                    slotWeekly = Number(parts[0]);
                    slotMonthly = Number(parts[1]);
                } else {
                    slotMonthly = Number(parts[0]);
                }
                const { addVpsProduct, addRdpProduct, addComboProduct } = require('./utils/vpsManager');
                let addFn;
                let typeLabel;
                if (adminSession.productType === 'combo') {
                    addFn = addComboProduct;
                    typeLabel = 'VPS/RDP (shared stock)';
                } else if (adminSession.productType === 'rdp') {
                    addFn = addRdpProduct;
                    typeLabel = 'RDP';
                } else {
                    addFn = addVpsProduct;
                    typeLabel = 'VPS';
                }
                await addFn({
                    apiId: adminSession.apiId,
                    sizeSlug: adminSession.sizeSlug,
                    ram: adminSession.ram,
                    core: adminSession.core,
                    priceDaily: adminSession.priceDaily,
                    priceWeekly: adminSession.priceWeekly,
                    priceMonthly: adminSession.priceMonthly,
                    slotDaily,
                    slotWeekly,
                    slotMonthly
                });
                sessionManager.clearAdminSession(chatId);
                await bot.sendMessage(chatId, `✅ Spesifikasi ${typeLabel} berhasil ditambahkan. Ketik /start untuk kembali.`);
                return;
            } else if (adminSession.action === 'vps_update_price') {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
                const parts = String(msg.text || '').trim().split(/\s+/).filter(Boolean);
                if (!parts.length || parts.length > 3 || parts.some(p => !/^[0-9]+$/.test(p))) {
                    await bot.sendMessage(chatId, '❌ Format salah. Masukkan: `harian mingguan bulanan` (angka saja). Contoh: `5000 30000 120000`', { parse_mode: 'Markdown' });
                    return;
                }
                let priceDaily = null, priceWeekly = null, priceMonthly = null;
                if (parts.length === 3) {
                    priceDaily = Number(parts[0]);
                    priceWeekly = Number(parts[1]);
                    priceMonthly = Number(parts[2]);
                } else if (parts.length === 2) {
                    priceWeekly = Number(parts[0]);
                    priceMonthly = Number(parts[1]);
                } else {
                    priceMonthly = Number(parts[0]);
                }

                const { updatePriceBySpec } = require('./utils/vpsManager');
                await updatePriceBySpec(adminSession.productType, adminSession.ram, adminSession.core, priceDaily, priceWeekly, priceMonthly, adminSession.provider || 'all');

                sessionManager.clearAdminSession(chatId);
                await bot.sendMessage(chatId, '✅ Harga berhasil diubah. Ketik /start untuk kembali.');
                return;
            } else if (adminSession.action === 'set_install_rdp_cost') {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
                if (!/^[0-9]+$/.test(msg.text.trim())) {
                    await bot.sendMessage(chatId, '❌ Harga harus angka.');
                    return;
                }
                const newCost = Number(msg.text.trim());
                const adminSettings = require('./utils/adminSettings');

                await adminSettings.setSetting('install_rdp_cost', newCost);
                sessionManager.clearAdminSession(chatId);
                await bot.sendMessage(chatId, `✅ Harga Install RDP berhasil diubah menjadi Rp ${newCost.toLocaleString('id-ID')}.`);
                return;
            } else if (adminSession.action === 'set_dedicated_install_rdp_cost') {
                try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
                if (!/^[0-9]+$/.test(msg.text.trim())) {
                    await bot.sendMessage(chatId, '❌ Harga harus angka.');
                    return;
                }
                const newCost = Number(msg.text.trim());
                const adminSettings = require('./utils/adminSettings');

                await adminSettings.setSetting('dedicated_install_rdp_cost', newCost);
                sessionManager.clearAdminSession(chatId);
                await bot.sendMessage(chatId, `✅ Harga Dedicated RDP Installer berhasil diubah menjadi Rp ${newCost.toLocaleString('id-ID')}.`);
                return;
            }

	        }

        const depositSession = sessionManager.getDepositSession(chatId);
        if (depositSession && depositSession.step === 'waiting_amount') {
            await handleDepositAmount(bot, msg, depositSession);
            sessionManager.clearDepositSession(chatId);
            return;
        }

        // Crypto deposit wizard: waiting for TX-ID / Order ID reply
        const cryptoSession = sessionManager.getUserSession(chatId);
        if (cryptoSession && cryptoSession.installType === 'crypto_deposit_manual') {
            const consumed = await cryptoDepositHandler.processTxRefSubmit(bot, msg, sessionManager);
            if (consumed) return;
        }

        // Custom RDP password wizard (rebuild flow, VPS&RDP Saya)
        const rebuildPassSession = sessionManager.getUserSession(chatId);
        if (rebuildPassSession && rebuildPassSession.installType === 'rdp_custom_password') {
            const consumed = await vpsOrder.processCustomPasswordInput(bot, msg, sessionManager);
            if (consumed) return;
        }

        // Custom RDP password wizard (initial order flow, Order RDP)
        const orderPassSession = sessionManager.getUserSession(chatId);
        if (orderPassSession && orderPassSession.installType === 'order_rdp_custom_password') {
            const consumed = await rdpOrder.processOrderCustomPasswordInput(bot, msg, sessionManager);
            if (consumed) return;
        }

        const cloud9Session = sessionManager.getUserSession(chatId);
        if (cloud9Session && cloud9Session.installType === 'cloud9_manual') {
            await cloud9Handler.processManualInstall(bot, msg, sessionManager);
            return;
        }

        const fastpanelSession = sessionManager.getUserSession(chatId);
        if (fastpanelSession && fastpanelSession.installType === 'fastpanel_manual') {
            await fastpanelHandler.processManualInstall(bot, msg, sessionManager);
            return;
        }

        // Premium renter: Cloud9 / Fastpanel manual install wizards
        // (waiting_ip → waiting_user → waiting_pass)
        const renterPremSession = sessionManager.getUserSession(chatId);
        if (renterPremSession &&
            (renterPremSession.installType === 'renter_c9_manual' ||
             renterPremSession.installType === 'renter_fp_manual')) {
            await renterPremiumHandler.processManualInstall(bot, msg, sessionManager);
            return;
        }

        const rdpSession = sessionManager.getUserSession(chatId);
        if (rdpSession) {
            if (rdpSession.installType === 'dedicated') {
                await handleDedicatedVPSCredentials(bot, msg, sessionManager);
            } else {
                await handleVPSCredentials(bot, msg, sessionManager);
            }
            return;
        }

        const accountSession = sessionManager.getAccountSession(chatId);
        if (accountSession) {
            bot.deleteMessage(chatId, msg.message_id);
            if (accountSession.step === 'waiting_account_number') {
                accountSession.accountNumber = msg.text;
                accountSession.step = 'waiting_account_holder_name';
                sessionManager.setAccountSession(chatId, accountSession);
                await safeMessageEditor.editMessage(bot, chatId, accountSession.messageId, 'Silakan masukkan nama pemilik rekening:');
            } else if (accountSession.step === 'waiting_account_holder_name') {
                accountSession.accountHolderName = msg.text;
                accountSession.step = 'waiting_withdraw_amount';
                sessionManager.setAccountSession(chatId, accountSession);
                await safeMessageEditor.editMessage(bot, chatId, accountSession.messageId, '💸 Silakan masukkan jumlah yang akan ditarik:');
            } else if (accountSession.step === 'waiting_withdraw_amount') {
                const amount = parseInt(msg.text);
                if (isNaN(amount) || amount <= 0) {
                    await safeMessageEditor.editMessage(bot, chatId, accountSession.messageId, 'Jumlah tidak valid.');
                    return;
                }

                const apiKey = process.env.DOMPETX_API_KEY;
                const refId = `${chatId}-${Date.now()}`;

                const data = qs.stringify({
                  'api_key': apiKey,
                  'ref_id': refId,
                  'kode_bank': accountSession.bankCode,
                  'nomor_akun': accountSession.accountNumber,
                  'nama_pemilik': accountSession.accountHolderName,
                  'nominal': amount
                });

                const config = {
                  method: 'post',
                  url: process.env.DOMPETX_WITHDRAW_URL || 'https://api.dompetx.com/v1/withdrawals',
                  headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded'
                  },
                  data: data
                };

                try {
                    const response = await axios(config);
                    if (response.data.status === true) {
                        await safeMessageEditor.editMessage(bot, chatId, accountSession.messageId, `✅ Penarikan berhasil!\n\nRef ID: ${response.data.data.reff_id}\nStatus: ${response.data.data.status}`);
                    } else {
                        await safeMessageEditor.editMessage(bot, chatId, accountSession.messageId, `❌ Penarikan gagal: ${response.data.message}`);
                    }
                } catch (error) {
                    console.error('Error withdrawing from Atlantic API:', error);
                    await safeMessageEditor.editMessage(bot, chatId, accountSession.messageId, '❌ Gagal melakukan penarikan dari API Atlantic.');
                }

                sessionManager.clearAccountSession(chatId);
            }
            return;
        }

                


    } catch (error) {
        await errorHandler.handleMessageError(error, msg, { chatId });
    }
});

process.on('SIGINT', async () => {
    console.log('\n🔄 Shutting down bot gracefully...');
    try {
        await bot.stopPolling();
        safeMessageEditor.clearAllCache(); // Clean up cache on shutdown
        console.log('✅ Bot stopped successfully');
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🔄 Received SIGTERM, shutting down...');
    try {
        await bot.stopPolling();
        safeMessageEditor.clearAllCache(); // Clean up cache on shutdown
        console.log('✅ Bot stopped successfully');
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
    }
    process.exit(0);
});

module.exports = { bot, sessionManager };