const { WINDOWS_VERSIONS, INSTALLATION_COST } = require('../config/constants');
const { BUTTONS, BUTTON_COMBINATIONS } = require('../config/buttons');
const { checkVPSSupport } = require('../utils/vpsChecker');
const { detectVPSSpecs } = require('../utils/vpsSpecs');
const { installRDP } = require('../utils/rdpInstaller');
const { installDedicatedRDP } = require('../utils/dedicatedRdpInstaller');
const { deductBalance, isAdmin } = require('../utils/userManager');
const { formatVPSSpecs } = require('../utils/messageFormatter');
const ValidationUtils = require('../utils/validation');
const adminSettings = require('../utils/adminSettings');

async function handleInstallRDP(bot, chatId, messageId, userSessions) {
    const installCost = await adminSettings.getNumber('install_rdp_cost', INSTALLATION_COST);
    await bot.editMessageText(
        '🖥️ **Pilih RDP Installation:**\n\n' +
        '• Instalasi cepat (10-15 menit)\n' +
        '• Berbagai versi Windows tersedia\n' +
        '• Port 3389 & 8006 (web interface)\n' +
        '• Cocok untuk testing & development\n\n' +
        '🖥️ **Dedicated RDP** - Rp 5.000\n' +
        '• Windows langsung di VPS (15-30 menit)\n' +
        '• Performa optimal\n' +
        '• Port 8765 (custom untuk keamanan)\n' +
        '• Cocok untuk production use',
        {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [BUTTONS.DEDICATED_RDP],
                    [BUTTONS.BACK_TO_MENU]
                ]
            }
        }
    );
}

    const session = sessionManager.getUserSession(chatId) || {};
    
    if (!isAdmin(chatId) && !await deductBalance(chatId, installCost)) {
        await bot.editMessageText(
            {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [BUTTON_COMBINATIONS.DEPOSIT_AND_BACK]
                }
            }
        );
        return;
    }

    
    const msg = await bot.editMessageText(
        `💰 **Harga:** Rp ${installCost.toLocaleString('id-ID')}\n` +
        '🔌 **Port:** 3389 (RDP) & 8006 (Web Interface)\n\n' +
        '⚡️ **Spesifikasi Minimal:**\n' +
        '• CPU: 2 Core\n' +
        '• RAM: 4 GB\n' +
        '• Storage: 40 GB\n\n' +
        '🌐 **Masukkan IP VPS:**\n' +
        '_IP akan dihapus otomatis setelah dikirim_\n\n' +
        '⚠️ **PENTING:** VPS Wajib Fresh Install Ubuntu 22.04',
        {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    BUTTONS.CANCEL
                ]]
            }
        }
    );

    session.step = 'waiting_ip';
    session.startTime = Date.now();
    session.messageId = msg.message_id;
    sessionManager.setUserSession(chatId, session);
}

async function handleInstallDedicatedRDP(bot, chatId, messageId, userSessions) {
    const session = sessionManager.getUserSession(chatId) || {};
    
    if (!isAdmin(chatId) && !await deductBalance(chatId, 5000)) {
        await bot.editMessageText(
            '❌ Saldo tidak mencukupi untuk Dedicated RDP (Rp 5.000). Silakan deposit terlebih dahulu.',
            {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[
                        { text: '💰 Deposit', callback_data: 'deposit' },
                        { text: '🏠 Kembali ke Menu Utama', callback_data: 'back_to_menu' }
                    ]]
                }
            }
        );
        return;
    }

    session.installType = 'dedicated';
    
    const msg = await bot.editMessageText(
        '🖥️ **Dedicated RDP Installation**\n\n' +
        '💰 **Harga:** Rp 5.000\n' +
        '🔧 **Fitur:** Windows langsung mengganti OS VPS\n' +
        '🔌 **Port:** 8765 (Custom untuk keamanan)\n\n' +
        '⚡️ **Spesifikasi Minimal:**\n' +
        '• CPU: 2 Core\n' +
        '• RAM: 4 GB\n' +
        '• Storage: 40 GB\n\n' +
        '🌐 **Masukkan IP VPS:**\n' +
        '_IP akan dihapus otomatis setelah dikirim_\n\n' +
        '⚠️ **PENTING:** VPS Wajib Fresh Install Ubuntu 24.04 LTS',
        {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    BUTTONS.CANCEL
                ]]
            }
        }
    );

    session.step = 'waiting_ip';
    session.startTime = Date.now();
    session.messageId = msg.message_id;
    sessionManager.setUserSession(chatId, session);
}

async function handleVPSCredentials(bot, msg, sessionManager) {
    const chatId = msg.chat.id;
    const session = sessionManager.getUserSession(chatId);
    
    if (!session) {
        await bot.sendMessage(chatId, '❌ Sesi telah kadaluarsa. Silakan mulai dari awal.');
        return;
    }

    try {
        await bot.deleteMessage(chatId, msg.message_id);
    } catch (error) {
        console.log('Failed to delete message:', error.message);
    }

    switch (session.step) {
        case 'waiting_ip':
            const ipValidation = ValidationUtils.validateIP(msg.text);
            if (!ipValidation.valid) {
                    : '🖥️ **Dedicated RDP Installation**\n\n🌐 **Masukkan IP VPS:**\n_IP akan dihapus otomatis setelah dikirim_\n\n⚠️ **PENTING:** VPS Wajib Fresh Install Ubuntu 24.04 LTS';
                
                await bot.editMessageText(
                    ValidationUtils.createErrorMessage(ipValidation.message, [
                        'Gunakan format: 192.168.1.1',
                        'Pastikan setiap bagian antara 0-255',
                        'Contoh: 1.2.3.4'
                    ]) + '\n\n' + errorMessage,
                    {
                        chat_id: chatId,
                        message_id: session.messageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                BUTTONS.CANCEL
                            ]]
                        }
                    }
                );
                return;
            }

            session.ip = msg.text;
            session.step = 'waiting_password';
            sessionManager.setUserSession(chatId, session);
            
            await bot.editMessageText(
                '🔑 **Password Root VPS:**\n' +
                '_Password akan dihapus otomatis_',
                {
                    chat_id: chatId,
                    message_id: session.messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            BUTTONS.CANCEL
                        ]]
                    }
                }
            );
            break;

        case 'waiting_password':
            session.password = msg.text;
            session.step = 'checking_vps';
            sessionManager.setUserSession(chatId, session);
            
            await bot.editMessageText(
                '🔍 Memeriksa VPS...',
                {
                    chat_id: chatId,
                    message_id: session.messageId,
                    parse_mode: 'Markdown'
                }
            );

            try {
                const [{ supported }, rawSpecs] = await Promise.all([
                    checkVPSSupport(session.ip, 'root', session.password),
                    detectVPSSpecs(session.ip, 'root', session.password)
                ]);

                session.supportsKvm = supported;
                session.rawSpecs = rawSpecs;
                
                    session.vpsConfig = {
                        cpu: rawSpecs.cpuCores,
                        ram: rawSpecs.memoryGB - 2,
                        storage: rawSpecs.diskGB - 10
                    };
                } else {
                    session.vpsConfig = {
                        cpu: rawSpecs.cpuCores,
                        ram: rawSpecs.memoryGB,
                        storage: rawSpecs.diskGB
                    };
                }

                sessionManager.setUserSession(chatId, session);

                const specsMessage = formatVPSSpecs(rawSpecs, session.vpsConfig);

                    if (!supported) {
                        await bot.editMessageText(
                            '⚠️ VPS Anda tidak mendukung KVM. Performa RDP mungkin akan menurun.\n\n' +
                            specsMessage +
                            'Ingin melanjutkan?',
                            {
                                chat_id: chatId,
                                message_id: session.messageId,
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [
                                            { text: '✅ Lanjutkan', callback_data: 'continue_no_kvm' },
                                            BUTTONS.CANCEL
                                        ]
                                    ]
                                }
                            }
                        );
                    } else {
                        await bot.editMessageText(
                            `✅ VPS mendukung KVM\n\n${specsMessage}Silakan klik lanjutkan untuk memilih versi Windows:`,
                            {
                                chat_id: chatId,
                                message_id: session.messageId,
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '✅ Lanjutkan', callback_data: 'show_windows_selection' }],
                                        [{ text: '❌ Batal', callback_data: 'cancel_installation' }]
                                    ]
                                }
                            }
                        );
                    }
                } else {
                    await bot.editMessageText(
                        `✅ VPS siap untuk instalasi dedicated RDP\n\n${specsMessage}Silakan pilih OS Windows:`,
                        {
                            chat_id: chatId,
                            message_id: session.messageId,
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '✅ Lanjutkan', callback_data: 'show_dedicated_os_selection' }],
                                    [{ text: '❌ Batal', callback_data: 'cancel_installation' }]
                                ]
                            }
                        }
                    );
                }

            } catch (error) {
                await bot.editMessageText(
                    '❌ Gagal terhubung ke VPS. Pastikan IP dan password benar.',
                    {
                        chat_id: chatId,
                        message_id: session.messageId,
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🔄 Coba Lagi', callback_data: retryCallback }
                            ]]
                        }
                    }
                );
                sessionManager.clearUserSession(chatId);
            }
            break;

        case 'waiting_rdp_password':
            const passwordValidation = ValidationUtils.validateRDPPassword(msg.text);
            if (!passwordValidation.valid) {
                    ? `${session.vpsConfig.ram}GB (dikurangi 2GB untuk host OS)`
                    : `${session.vpsConfig.ram}GB (full spec - no reduction)`;
                
                    ? `${session.vpsConfig.storage}GB (dikurangi 10GB untuk host OS)`
                    : `${session.vpsConfig.storage}GB (full spec - no reduction)`;

                await bot.editMessageText(
                    ValidationUtils.createErrorMessage(passwordValidation.message, [
                        'Minimal 8 karakter',
                        'Harus mengandung huruf dan angka',
                        'Contoh: Password123'
                    ]) + '\n\n' +
                    `📋 **Konfigurasi yang dipilih:**\n\n` +
                    `🪟 OS: ${session.windowsVersion?.name || session.selectedOS?.name}\n` +
                    `💰 Harga: Rp ${(session.windowsVersion?.price || session.selectedOS?.price).toLocaleString()}\n\n` +
                    `⚙️ **Spesifikasi Setelah Instalasi:**\n` +
                    `• CPU: ${session.vpsConfig.cpu} Core (full)\n` +
                    `• RAM: ${ramInfo}\n` +
                    `• Storage: ${storageInfo}\n\n` +
                    `🔑 Masukkan password untuk RDP Windows:\n` +
                    `_(Min. 8 karakter, kombinasi huruf dan angka)_`,
                    {
                        chat_id: chatId,
                        message_id: session.messageId,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                BUTTONS.BACK_TO_WINDOWS
                            ]]
                        }
                    }
                );
                return;
            }

            session.rdpPassword = msg.text;
            
            if (session.installType === 'dedicated') {
                await bot.editMessageText(
                    '🔄 **Memulai instalasi Windows Dedicated...**\n\n' +
                    '⏳ Proses ini membutuhkan waktu 15-30 menit.\n' +
                    '🔍 Sistem akan reboot dan menginstall Windows langsung ke VPS.\n\n' +
                    '📝 Monitoring progress...',
                    {
                        chat_id: chatId,
                        message_id: session.messageId,
                        parse_mode: 'Markdown'
                    }
                );

                try {
                    const result = await installDedicatedRDP(session.ip, 'root', session.password, {
                        osVersion: session.selectedOS?.version || 'win_10',
                        password: session.rdpPassword
                    }, (progress) => {
                        bot.editMessageText(
                            '🔄 **Instalasi Windows Dedicated berlangsung...**\n\n' +
                            `⏱️ Dimulai: ${Math.floor((Date.now() - session.startTime) / 60000)} menit yang lalu\n\n` +
                            `📋 **Status Terkini:**\n${progress}\n\n` +
                            '⚠️ **Jangan tutup chat ini sampai instalasi selesai!**',
                            {
                                chat_id: chatId,
                                message_id: session.messageId,
                                parse_mode: 'Markdown'
                            }
                        ).catch(err => console.log('Failed to update progress:', err.message));
                    });

                    const totalTime = result.installationTime || Math.floor((Date.now() - session.startTime) / 60000);
                    
                    await bot.editMessageText(
                        `🎉 **Dedicated RDP Installation Completed!**\n\n` +
                        `📋 **Detail Server:**\n` +
                        `🖥️ OS: ${session.selectedOS?.name || 'Windows 10'}\n` +
                        `🌐 IP: ${session.ip}:8765\n` +
                        `👤 Username: administrator\n` +
                        `🔑 Password: ${session.rdpPassword}\n\n` +
                        `⚙️ **Full Specifications:**\n` +
                        `• CPU: ${session.vpsConfig.cpu} Core (full)\n` +
                        `• RAM: ${session.vpsConfig.ram}GB (full)\n` +
                        `• Storage: ${session.vpsConfig.storage}GB (full)\n\n` +
                        `⏱️ **Installation Time:** ${totalTime} menit\n` +
                        `🔌 **Custom Port:** 8765 (untuk keamanan)\n\n` +
                        `🔄 **Status:** Windows sedang booting...\n` +
                        `⏳ **Tunggu 10-15 menit** untuk Windows fully boot`,
                        {
                            chat_id: chatId,
                            message_id: session.messageId,
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🏠 Kembali ke Menu Utama', callback_data: 'back_to_menu' }]
                                ]
                            }
                        }
                    );

                    await bot.sendMessage(
                        chatId,
                        `🎯 **Cara Connect ke Dedicated RDP:**\n\n` +
                        `**1. Tunggu 10-15 menit** agar Windows selesai booting\n\n` +
                        `**2. Gunakan RDP Client:**\n` +
                        `• Server: ${session.ip}:8765\n` +
                        `• Username: administrator\n` +
                        `• Password: ${session.rdpPassword}\n\n` +
                        `**3. Jika tidak bisa connect:**\n` +
                        `• Tunggu beberapa menit lagi\n` +
                        `• Windows mungkin masih setup initial configuration\n` +
                        `• Coba connect ulang setiap 5 menit\n\n` +
                        `✅ **Server siap digunakan setelah Windows fully boot!**`,
                        {
                            parse_mode: 'Markdown'
                        }
                    );

                } catch (error) {
                    console.error('Dedicated Installation error:', error);
                    await bot.editMessageText(
                        '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.',
                        {
                            chat_id: chatId,
                            message_id: session.messageId,
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🔄 Coba Lagi', callback_data: 'install_dedicated_rdp' }],
                                    [{ text: '🏠 Kembali ke Menu Utama', callback_data: 'back_to_menu' }]
                                ]
                            }
                        }
                    );
                }
            } else {
                await bot.editMessageText(
                    '⏳ Proses ini membutuhkan waktu 10-15 menit.\n' +
                    '📝 Mohon tunggu hingga proses selesai.',
                    {
                        chat_id: chatId,
                        message_id: session.messageId,
                        parse_mode: 'Markdown'
                    }
                );

                try {
                    const result = await installRDP(session.ip, 'root', session.password, {
                        windowsId: session.windowsVersion.id,
                        ...session.vpsConfig,
                        password: session.rdpPassword,
                        isArm: false,
                        supportsKvm: session.supportsKvm
                    });

                    const duration = Math.floor((Date.now() - session.startTime) / 60000);
                    
                    await bot.editMessageText(
                        `📋 **Detail RDP:**\n` +
                        `🖥️ Windows: ${session.windowsVersion.name}\n` +
                        `🌐 IP: ${session.ip}:3389\n` +
                        `👤 Username: administrator\n` +
                        `🔑 Password: ${session.rdpPassword}\n\n` +
                        `⚙️ **Spesifikasi:**\n` +
                        `CPU: ${session.vpsConfig.cpu} Core\n` +
                        `RAM: ${session.vpsConfig.ram}GB\n` +
                        `Storage: ${session.vpsConfig.storage}GB\n\n` +
                        `⏱️ Waktu instalasi: ${duration} menit\n\n` +
                        `🔗 **Web Interface:** http://${session.ip}:8006`,
                        {
                            chat_id: chatId,
                            message_id: session.messageId,
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '🖥️ Monitor Installation', url: `http://${session.ip}:8006` }],
                                    [{ text: '🏠 Kembali ke Menu Utama', callback_data: 'back_to_menu' }]
                                ]
                            }
                        }
                    );

                    await bot.sendMessage(
                        chatId,
                        `🔒 **Cara Mengatasi Account RDP di Locked**\n\n` +
                        `**1. Mengatur Account Lockout Threshold Jadi Nol**\n\n` +
                        `Langkah pertama ini bakal bikin akun kamu nggak akan terkunci lagi walaupun ada beberapa kali login gagal. Cocok banget buat menghindari gangguan penguncian akun.\n\n` +
                        `**Caranya:**\n` +
                        `1. Tekan tombol Windows + R, ketik secpol.msc, lalu tekan Enter.\n` +
                        `2. Ini akan membuka jendela Local Security Policy.\n` +
                        `3. Pergi ke Account Policies > Account Lockout Policy.\n` +
                        `4. Cari Account lockout threshold, klik dua kali.\n` +
                        `5. Ubah nilainya jadi 0 (nol), lalu klik OK.\n\n` +
                        `**2. Ubah Port RDP dari Default (3389)**\n\n` +
                        `Port RDP default (3389) adalah sasaran empuk buat para hacker yang iseng nyoba brute force attack. Nah, solusinya adalah mengubah port ini ke angka yang tidak biasa.\n\n` +
                        `**Langkah-langkah:**\n` +
                        `1. Tekan Windows + R, ketik regedit, tekan Enter.\n` +
                        `2. Masuk ke: HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp\\PortNumber\n` +
                        `3. Di panel kanan, klik dua kali PortNumber.\n` +
                        `4. Ubah ke Decimal, terus masukkan nomor port baru yang kamu mau, misalnya 50000.\n` +
                        `5. Klik OK buat menyimpan perubahan.\n\n` +
                        `**3. Tambahkan Port Baru ke Firewall**\n\n` +
                        `**Tambahkan Inbound Rule untuk Port RDP Baru**\n` +
                        `1. Tekan Windows + R, ketik wf.msc, terus tekan Enter\n` +
                        `2. Di panel kiri, klik Inbound Rules\n` +
                        `3. Di panel kanan, pilih New Rule....\n` +
                        `4. Pilih Port, klik Next\n` +
                        `5. Pilih TCP, terus masukkan port baru (contoh: 50000)\n` +
                        `6. Klik Next, pilih Allow the connection\n` +
                        `7. Centang semua profil (Domain, Private, Public)\n` +
                        `8. Beri nama (misal: RDP Custom Port 50000)\n\n` +
                        `**Tambahkan Outbound Rule untuk Port RDP Baru**\n` +
                        `1. Klik Outbound Rules di panel kiri\n` +
                        `2. Ikuti langkah yang sama seperti Inbound\n` +
                        `3. Beri nama yang sesuai (misal: RDP Outbound Port 50000)\n\n` +
                        `_Restart server untuk menerapkan perubahan._`,
                        {
                            parse_mode: 'Markdown'
                        }
                    );

                } catch (error) {
                    console.error('Installation error:', error);
                    await bot.editMessageText(
                        '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.',
                        {
                            chat_id: chatId,
                            message_id: session.messageId,
                            reply_markup: {
                                inline_keyboard: [[{ text: '🏠 Kembali ke Menu Utama', callback_data: 'back_to_menu' }]]
                            }
                        }
                    );
                }
            }

            sessionManager.clearUserSession(chatId);
            break;
    }
}

async function showWindowsSelection(bot, chatId, messageId, page = 0) {
    const itemsPerPage = 6;
    const start = page * itemsPerPage;
    const end = start + itemsPerPage;

    // Keep rebuild OS list consistent with Order RDP list (Windows Server 2025 is not offered)
    const AVAILABLE_WINDOWS = WINDOWS_VERSIONS.filter(v => v && v.name !== 'Windows Server 2025');
    const desktopVersions = AVAILABLE_WINDOWS.filter(v => v.category === 'desktop');
    const serverVersions = AVAILABLE_WINDOWS.filter(v => v.category === 'server');

    let messageText = '🪟 **Pilih Versi Windows:**\n\n';
    messageText += '📱 **Windows Desktop:**\n';
    desktopVersions.forEach(v => {
        messageText += `${v.id}. ${v.name} (Rp ${v.price.toLocaleString()})\n`;
    });
    messageText += '\n🖥️ **Windows Server:**\n';
    serverVersions.forEach(v => {
        messageText += `${v.id}. ${v.name} (Rp ${v.price.toLocaleString()})\n`;
    });

    const versions = AVAILABLE_WINDOWS.slice(start, end);
    const keyboard = [];

    for (let i = 0; i < versions.length; i += 2) {
        const row = [];
        row.push({
            text: `${versions[i].id}. ${versions[i].name}`,
            callback_data: `windows_${versions[i].id}`
        });

        if (versions[i + 1]) {
            row.push({
                text: `${versions[i + 1].id}. ${versions[i + 1].name}`,
                callback_data: `windows_${versions[i + 1].id}`
            });
        }

        keyboard.push(row);
    }

    const navigationRow = [];
    if (page > 0) {
        navigationRow.push({ text: '⬅️ Sebelumnya', callback_data: `page_${page - 1}` });
    }

    if (end < AVAILABLE_WINDOWS.length) {
        navigationRow.push({ text: 'Selanjutnya ➡️', callback_data: `page_${page + 1}` });
    }

    if (navigationRow.length > 0) {
        keyboard.push(navigationRow);
    }

    keyboard.push([{ text: '🏠 Kembali ke Menu Utama', callback_data: 'back_to_menu' }]);

    await bot.editMessageText(messageText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function showDedicatedOSSelection(bot, chatId, messageId, userSessions) {
    const session = sessionManager.getUserSession(chatId);
    
    if (!session) {
        await bot.answerCallbackQuery(query.id, {
            text: '❌ Sesi telah kadaluarsa. Silakan mulai dari awal.',
            show_alert: true
        });
        return;
    }

    const osOptions = [
        { version: 'win_10', name: 'Windows 10 Pro', price: 5000 },
        { version: 'win_22', name: 'Windows Server 2022', price: 5000 },
        { version: 'win_19', name: 'Windows Server 2019', price: 5000 },
        { version: 'win_12', name: 'Windows Server 2012', price: 5000 }
    ];

    let messageText = '🖥️ **Pilih OS untuk Dedicated RDP:**\n\n';
    osOptions.forEach((os, index) => {
        messageText += `${index + 1}. ${os.name} (Rp ${os.price.toLocaleString()})\n`;
    });

    const keyboard = [];
    for (let i = 0; i < osOptions.length; i += 2) {
        const row = [];
        row.push({
            text: `${osOptions[i].name}`,
            callback_data: `dedicated_os_${osOptions[i].version}`
        });

        if (osOptions[i + 1]) {
            row.push({
                text: `${osOptions[i + 1].name}`,
                callback_data: `dedicated_os_${osOptions[i + 1].version}`
            });
        }

        keyboard.push(row);
    }

    keyboard.push([{ text: '« Kembali', callback_data: 'back_to_windows' }]);

    await bot.editMessageText(messageText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function handleWindowsSelection(bot, query, sessionManager) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const session = sessionManager.getUserSession(chatId);
    
    if (!session || !session.vpsConfig) {
        await bot.answerCallbackQuery(query.id, {
            text: '❌ Sesi Anda telah berakhir atau tidak valid. Silakan mulai lagi.',
            show_alert: true
        });
        return;
    }

    const windowsId = parseInt(query.data.split('_')[1]);
    const selectedWindows = WINDOWS_VERSIONS.find(v => v.id === windowsId);
    
    if (!selectedWindows) {
        await bot.answerCallbackQuery(query.id, {
            text: '❌ Versi Windows tidak valid. Silakan pilih kembali.',
            show_alert: true
        });
        return;
    }

    // Safety: Windows Server 2025 is not offered (keep consistent with Order RDP list)
    if (selectedWindows.name === 'Windows Server 2025') {
        await bot.answerCallbackQuery(query.id, {
            text: '❌ Windows Server 2025 tidak tersedia. Silakan pilih versi lain.',
            show_alert: true
        });
        return;
    }

    session.windowsVersion = selectedWindows;
    session.step = 'waiting_rdp_password';
    sessionManager.setUserSession(chatId, session);
    
        ? `${session.vpsConfig.ram}GB (dikurangi 2GB untuk host OS)`
        : `${session.vpsConfig.ram}GB (full spec - no reduction)`;
    
        ? `${session.vpsConfig.storage}GB (dikurangi 10GB untuk host OS)`
        : `${session.vpsConfig.storage}GB (full spec - no reduction)`;

    await bot.editMessageText(
        `📋 **Konfigurasi yang dipilih:**\n\n` +
        `🪟 Windows: ${selectedWindows.name}\n` +
        `💰 Harga: Rp ${selectedWindows.price.toLocaleString()}\n\n` +
        `⚙️ **Spesifikasi Setelah Instalasi:**\n` +
        `• CPU: ${session.vpsConfig.cpu} Core (full)\n` +
        `• RAM: ${ramInfo}\n` +
        `• Storage: ${storageInfo}\n\n` +
        `🔑 Masukkan password untuk RDP Windows:\n` +
        `_(Min. 8 karakter, kombinasi huruf dan angka)_`,
        {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '« Kembali', callback_data: 'back_to_windows' }
                ]]
            }
        }
    );
}

async function handleDedicatedOSSelection(bot, query, sessionManager) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const session = sessionManager.getUserSession(chatId);
    
    if (!session) {
        await bot.answerCallbackQuery(query.id, {
            text: '❌ Sesi telah kadaluarsa. Silakan mulai dari awal.',
            show_alert: true
        });
        return;
    }

    const osVersion = query.data.split('_')[2];
    
    const osOptions = {
        'win_10': { version: 'win_10', name: 'Windows 10 Pro', price: 5000 },
        'win_22': { version: 'win_22', name: 'Windows Server 2022', price: 5000 },
        'win_19': { version: 'win_19', name: 'Windows Server 2019', price: 5000 },
        'win_12': { version: 'win_12', name: 'Windows Server 2012', price: 5000 }
    };

    const selectedOS = osOptions[osVersion];
    
    if (!selectedOS) {
        await bot.answerCallbackQuery(query.id, {
            text: '❌ OS tidak valid. Silakan pilih kembali.',
            show_alert: true
        });
        return;
    }

    session.selectedOS = selectedOS;
    session.step = 'waiting_rdp_password';
    sessionManager.setUserSession(chatId, session);
    
    await bot.editMessageText(
        `📋 **Konfigurasi yang dipilih:**\n\n` +
        `🖥️ Dedicated RDP\n` +
        `🪟 OS: ${selectedOS.name}\n` +
        `💰 Harga: Rp ${selectedOS.price.toLocaleString()}\n\n` +
        `⚙️ **Spesifikasi Setelah Instalasi:**\n` +
        `• CPU: ${session.vpsConfig.cpu} Core (full)\n` +
        `• RAM: ${session.vpsConfig.ram}GB (full spec - no reduction)\n` +
        `• Storage: ${session.vpsConfig.storage}GB (full spec - no reduction)\n\n` +
        `🔑 Masukkan password untuk RDP Windows:\n` +
        `_(Min. 8 karakter, kombinasi huruf dan angka)_`,
        {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '« Kembali', callback_data: 'back_to_dedicated_os' }
                ]]
            }
        }
    );
}

async function handlePageNavigation(bot, query, sessionManager) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const page = parseInt(query.data.split('_')[1]);
    await showWindowsSelection(bot, chatId, messageId, page);
}

async function handleCancelInstallation(bot, query, sessionManager) {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    sessionManager.clearUserSession(chatId);
    
    await bot.editMessageText(
        '❌ Instalasi dibatalkan.',
        {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[
                    { text: '🏠 Kembali ke Menu Utama', callback_data: 'back_to_menu' }
                ]]
            }
        }
    );
}

module.exports = {
    handleInstallRDP,
    handleInstallDedicatedRDP,
    handleVPSCredentials,
    handleWindowsSelection,
    handleDedicatedOSSelection,
    showWindowsSelection,
    showDedicatedOSSelection,
    handlePageNavigation,
    handleCancelInstallation
};