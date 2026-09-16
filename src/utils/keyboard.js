const { BUTTONS } = require('../config/buttons');

function createMainMenu(isAdmin = false, hasPendingPayment = false) {
    const keyboard = [
        [
            BUTTONS.INSTALL_RDP,
            BUTTONS.VPS_RDP_MENU
        ],
        [
            BUTTONS.AUTO_ORDER
        ],
        [
            BUTTONS.CLOUD9_MENU,
            BUTTONS.FASTPANEL_MENU
        ],
        [
            BUTTONS.DEPOSIT,
            BUTTONS.CHECK_BALANCE
        ],
        [
            BUTTONS.MY_VPS,
            BUTTONS.PROVIDERS
        ],
        [
            BUTTONS.TUTORIAL,
            BUTTONS.FAQ
        ]
    ];

    // Tombol sewa/renter hanya untuk user biasa/renter.
    // Admin sudah punya menu khusus ADMIN SEWA, jadi tidak perlu tombol ini.
    if (!isAdmin) {
        keyboard.splice(2, 0, [
            BUTTONS.RENTER_MENU
        ]);
    }

    if (hasPendingPayment) {
        keyboard.splice(2, 0, [
            BUTTONS.CHECK_PAYMENT
        ]);
    }

    if (isAdmin) {
        keyboard.splice(2, 0, [
            BUTTONS.ADD_BALANCE,
            BUTTONS.BROADCAST
        ], [
            BUTTONS.MANAGE_DB,
            BUTTONS.VPS_ADMIN
        ], [
            BUTTONS.ATLANTIC_ADMIN,
            BUTTONS.ADMIN_RENTER
        ], [
            BUTTONS.CRYPTO_ADMIN
        ]);
    }

    return {
        reply_markup: {
            inline_keyboard: keyboard
        }
    };
}

module.exports = {
    createMainMenu
};
