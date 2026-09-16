// Standardized button texts and callback data
const BUTTONS = {
    // Navigation buttons
    BACK_TO_MENU: { text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' },
    BACK_TO_WINDOWS: { text: '« Kembali', callback_data: 'back_to_windows' },
    BACK_TO_DEDICATED_OS: { text: '« Kembali', callback_data: 'back_to_dedicated_os' },
    BACK: { text: '« Kembali', callback_data: 'back_to_menu' },
    
    // Action buttons
    CANCEL: { text: '❌ Batal', callback_data: 'cancel_installation' },
    CANCEL_PAYMENT: { text: '❌ Batalkan', callback_data: 'cancel_payment' },
    CONTINUE: { text: '✅ Lanjutkan', callback_data: 'continue_no_kvm' },
    TRY_AGAIN: { text: '🔄 Coba Lagi', callback_data: 'try_again' },
    
    // Service buttons
    DEPOSIT: { text: '💰 Deposit', callback_data: 'deposit' },
    WITHDRAW_BALANCE: { text: '💸 Tarik Saldo', callback_data: 'withdraw_balance' },
    TUTORIAL: { text: '📚 Tutorial', callback_data: 'tutorial' },
    FAQ: { text: '❓ FAQ', callback_data: 'faq' },
    PROVIDERS: { text: '🏢 Provider', callback_data: 'providers' },
    // VPS buttons
    VPS_RDP_MENU: { text: '🖥️ VPS & RDP', callback_data: 'vps_rdp_menu' },
    ORDER_VPS: { text: '🖥️ Order VPS', callback_data: 'order_vps' },
    ORDER_RDP: { text: '🖥️ Order RDP', callback_data: 'order_rdp' },
    MY_VPS: { text: '🗂️ VPS&RDP Saya', callback_data: 'my_services' },
    CHECK_BALANCE: { text: '👛 Cek Saldo', callback_data: 'check_balance' },

    // Auto Order / Shop
    AUTO_ORDER: { text: '🛒 Produk Digital', callback_data: 'shop_menu' },
    CLOUD9_MENU: { text: '☁️ CLOUD9', callback_data: 'cloud9_menu' },
    FASTPANEL_MENU: { text: '⚡ FASTPANEL', callback_data: 'fastpanel_menu' },
    RENTER_MENU: { text: '🔐 Menu Renter / Sewa Bot', callback_data: 'renter_menu' },

    // VPS admin buttons
    VPS_ADMIN: { text: '🖥️ VPS Admin', callback_data: 'vps_admin' },

    
    // RDP buttons
    INSTALL_RDP: { text: '🖥️ Install RDPmu', callback_data: 'install_rdp' },
    DEDICATED_RDP: { text: '🖥️ Dedicated RDP', callback_data: 'install_dedicated_rdp' },
    
    // Admin buttons
    ADD_BALANCE: { text: '💳 Tambah Saldo', callback_data: 'add_balance' },
    BROADCAST: { text: '📢 Broadcast', callback_data: 'broadcast' },
    MANAGE_DB: { text: '📊 Database', callback_data: 'manage_db' },
    ATLANTIC_ADMIN: { text: '💳 Menu Payment', callback_data: 'atlantic_admin' },
    ADMIN_RENTER: { text: '🏷️ Admin Sewa', callback_data: 'admin_renter_menu' },
    CRYPTO_ADMIN: { text: '🪙 Crypto Settings', callback_data: 'crypto_admin_menu' },

    // Bank buttons
    BCA: { text: 'BCA', callback_data: 'bank_bca' },
    SEABANK: { text: 'Seabank', callback_data: 'bank_seabank' },
    
    // Copy buttons
    COPY_RDP: { text: '📋 Copy Detail RDP', callback_data: 'copy_rdp' },
    COPY_SERVER: { text: '📋 Copy Server', callback_data: 'copy_server' },
    COPY_PASSWORD: { text: '📋 Copy Password', callback_data: 'copy_pass' },
    COPY_HOSTNAME: { text: '📋 Copy Hostname', callback_data: 'copy_hostname' },
    
    // Guide buttons
    RDP_GUIDE: { text: '📖 Panduan Koneksi', callback_data: 'rdp_connection_guide' },
    TEST_RDP: { text: '🔍 Test RDP Manual', callback_data: 'test_rdp' },
    CHECK_RDP: { text: '🔍 Cek Status RDP', callback_data: 'check_rdp' },
    
    // Payment buttons
    CHECK_PAYMENT: { text: '📋 Tagihan Pembayaran Kamu', callback_data: 'check_pending_payment' },
    BACKUP_NOW: { text: '💾 Backup Sekarang', callback_data: 'backup_now' },
    RESTORE_DB: { text: '♻️ Restore Backup', callback_data: 'restore_db' }
};

// Helper functions to create button arrays
const createButtonRow = (...buttons) => [buttons];
const createButtonGrid = (buttons) => buttons.map(row => row.map(btn => BUTTONS[btn]));

// Common button combinations
const BUTTON_COMBINATIONS = {
    BACK_ONLY: [BUTTONS.BACK_TO_MENU],
    CANCEL_ONLY: [BUTTONS.CANCEL],
    BACK_AND_CANCEL: [BUTTONS.BACK, BUTTONS.CANCEL],
    DEPOSIT_AND_BACK: [BUTTONS.DEPOSIT, BUTTONS.BACK_TO_MENU],
    TRY_AGAIN_AND_BACK: [BUTTONS.TRY_AGAIN, BUTTONS.BACK_TO_MENU],
    COPY_BUTTONS: [BUTTONS.COPY_RDP, BUTTONS.RDP_GUIDE, BUTTONS.BACK_TO_MENU],
    RDP_ACTIONS: [BUTTONS.COPY_SERVER, BUTTONS.COPY_PASSWORD, BUTTONS.COPY_HOSTNAME]
};

module.exports = {
    BUTTONS,
    createButtonRow,
    createButtonGrid,
    BUTTON_COMBINATIONS
};