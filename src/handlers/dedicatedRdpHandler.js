const { DEDICATED_OS_VERSIONS, DEDICATED_INSTALLATION_COST } = require('../config/constants');
const { RDP_MONITOR_TIMEOUT_MS } = require('../utils/rdpPasswordUtil');

const { checkVPSSupport } = require('../utils/vpsChecker');
const { detectVPSSpecs, checkVPSRequirements } = require('../utils/vpsSpecs');
const { installDedicatedRDP } = require('../utils/dedicatedRdpInstaller');

const { deductBalance, getBalance, isAdmin } = require('../utils/userManager');
const RDPMonitor = require('../utils/rdpMonitor');
const safeMessageEditor = require('../utils/safeMessageEdit');
const adminSettings = require('../utils/adminSettings');

async function handleInstallDedicatedRDP(bot, chatId, messageId, sessionManager, options = {}) {
  const isFreeRenter = !!options.freeForRenter;
  const installCost = isFreeRenter ? 0 : await adminSettings.getNumber('dedicated_install_rdp_cost', DEDICATED_INSTALLATION_COST);
  // IMPORTANT: Jangan potong saldo saat user baru klik menu.
  // Saldo hanya dipotong ketika instalasi benar-benar dimulai.
  if (!isFreeRenter && !isAdmin(chatId)) {
    const bal = await getBalance(chatId);
    if (typeof bal === 'number' && bal < installCost) {
      await safeMessageEditor.editMessage(bot, chatId, messageId,
        `💰 Saldo tidak mencukupi untuk Dedicated RDP (Rp ${installCost.toLocaleString('id-ID')}). Silakan deposit terlebih dahulu.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 Deposit', callback_data: 'deposit' }, { text: '🏠 Kembali', callback_data: 'back_to_menu' }]
            ]
          }
        }
      );
      return;
    }
  }

  const session = sessionManager.getUserSession(chatId) || {};
  session.installType = 'dedicated';
  session.installCost = installCost;
  session.chargePending = !isFreeRenter && !isAdmin(chatId);
  session.freeForRenter = isFreeRenter;

  // Simpan konteks biaya/flag; STEP dipilih setelah user memilih sumber instalasi.
  session.messageId = messageId;
  delete session.step;
  sessionManager.setUserSession(chatId, session);

  // BARU (4c): tawarkan pilihan sumber VPS untuk RDP.
  return bot.editMessageText(
    '🖥️ *Instalasi RDP Dedicated*\n\n' +
    `💰 Harga: ${isFreeRenter ? 'GRATIS (Penyewa)' : 'Rp ' + installCost.toLocaleString('id-ID')}\n` +
    '🔒 Port: 4443 (custom untuk keamanan)\n\n' +
    'Pilih sumber VPS untuk RDP:\n\n' +
    '1️⃣ *Kredensial VPS manual* — kamu sudah punya VPS, tinggal masukkan IP + user + password.\n' +
    '2️⃣ *API cloud sendiri* — bot otomatis membuat VPS di akun cloud milikmu (DigitalOcean/Linode/AWS) lalu install RDP, seperti menu renter.',
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '1️⃣ Pakai kredensial VPS manual', callback_data: 'install_src_manual' }],
          [{ text: '2️⃣ Pakai API cloud sendiri', callback_data: 'install_src_api' }],
          [{ text: '❌ Batal', callback_data: 'cancel_installation' }]
        ]
      }
    }
  );
}

// Menampilkan prompt input kredensial VPS manual (langkah pertama: IP).
// Dipisah agar bisa dipanggil setelah user memilih "kredensial VPS manual".
async function showManualCredsPrompt(bot, chatId, messageId, sessionManager) {
  const session = sessionManager.getUserSession(chatId) || {};
  // Pastikan konteks dedicated tetap ada (mis. jika sesi baru).
  session.installType = 'dedicated';

  const msg = await bot.editMessageText(
    '🖥️ Instalasi RDP Dedicated (Kredensial VPS Manual)\n\n' +
    '🔒 Port: 4443 (custom untuk keamanan)\n\n' +
    '📋 Spesifikasi Minimal:\n' +
    '• ⚡ CPU: 1 Core\n' +
    '• 💾 RAM: 1 GB\n' +
    '• 💽 Storage: 20 GB\n\n' +
    '🌐 Masukkan IP VPS:\n' +
    'IP akan dihapus otomatis setelah dikirim\n\n' +
    '⚠️ PENTING: VPS Wajib Fresh Install Ubuntu 24.04 LTS',
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '« Kembali', callback_data: 'install_dedicated_rdp' }, { text: '❌ Batal', callback_data: 'cancel_installation' }]
        ]
      }
    }
  );

  session.step = 'waiting_ip';
  session.startTime = Date.now();
  session.messageId = msg.message_id;
  sessionManager.setUserSession(chatId, session);
}

async function handleDedicatedVPSCredentials(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getUserSession(chatId);

  if (!session || session.installType !== 'dedicated') {
    await bot.sendMessage(chatId, '⏰ Sesi telah kadaluarsa. Silakan mulai dari awal.');
    return;
  }

  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (error) {
    console.log('Gagal menghapus pesan:', error.message);
  }

  switch (session.step) {
    case 'waiting_ip':
      const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (!ipRegex.test(msg.text)) {
        await safeMessageEditor.editMessage(bot, chatId, session.messageId,
          '❌ Format IP tidak valid.\n\n' +
          '🖥️ Instalasi RDP Dedicated\n\n' +
          '🌐 IP VPS:\n' +
          'IP akan dihapus otomatis setelah dikirim\n\n' +
          '⚠️ PENTING: VPS Wajib Fresh Install Ubuntu 24.04 LTS',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '❌ Batal', callback_data: 'cancel_installation' }]
              ]
            }
          }
        );
        return;
      }

      session.ip = msg.text;
      session.step = 'waiting_auth_method';
      sessionManager.setUserSession(chatId, session);

      await safeMessageEditor.editMessage(bot, chatId, session.messageId,
        `🔐 Pilih metode login SSH VPS:

` +
        `• Password Root untuk VPS biasa/DigitalOcean/Linode
` +
        `• SSH Key AWS untuk EC2 yang login memakai file .pem

` +
        `Pilih metode login:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔑 Password Root', callback_data: 'dedicated_auth_password' }],
              [{ text: '🗝️ SSH Key AWS (.pem)', callback_data: 'dedicated_auth_key' }],
              [{ text: '❌ Batal', callback_data: 'cancel_installation' }]
            ]
          }
        }
      );
      break;

    case 'waiting_password':
      session.password = msg.text;
      session.step = 'checking_vps';
      sessionManager.setUserSession(chatId, session);

      await safeMessageEditor.editMessage(bot, chatId, session.messageId, '🔍 Memeriksa VPS...');

      try {
        const vpsCheck = await checkVPSRequirements(session.ip, 'root', session.password);
        
        if (!vpsCheck.success) {
          throw new Error(vpsCheck.error || 'Gagal memeriksa VPS');
        }

        session.rawSpecs = vpsCheck.specs;
        
        let hostname = vpsCheck.specs.hostname || vpsCheck.specs.hostname_short || 'unknown';
        if (hostname === 'unknown' || !hostname || hostname.trim() === '') {
          hostname = `RDP-${session.ip.split('.').join('')}`;
        }
        session.hostname = hostname;

        if (!vpsCheck.meets_requirements) {
          const reqDetails = vpsCheck.requirements_details;
          await safeMessageEditor.editMessage(bot, chatId, session.messageId,
            `❌ VPS tidak memenuhi spesifikasi minimal\n\n` +
            `🖥️ Spesifikasi VPS saat ini:\n` +
            `${reqDetails.memory.status} RAM: ${reqDetails.memory.current} GB (min: ${reqDetails.memory.required} GB)\n` +
            `${reqDetails.disk.status} Storage: ${reqDetails.disk.current} GB (min: ${reqDetails.disk.required} GB)\n` +
            `${reqDetails.cpu.status} CPU: ${reqDetails.cpu.current} Core (min: ${reqDetails.cpu.required} Core)\n\n` +
            `⚠️ Silakan gunakan VPS dengan spesifikasi yang lebih tinggi.`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Coba Lagi', callback_data: 'install_dedicated_rdp' }],
                  [{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]
                ]
              }
            }
          );
          sessionManager.clearUserSession(chatId);
          return;
        }

        await safeMessageEditor.editMessage(bot, chatId, session.messageId,
          `🖥️ VPS siap untuk instalasi RDP dedicated\n\n` +
          `🌐 IP Server: ${session.ip}\n` +
          `🏷️ Hostname: ${session.hostname}\n` +
          `💾 RAM: ${vpsCheck.specs.memory} (${vpsCheck.specs.memoryGB} GB)\n` +
          `💽 Storage: ${vpsCheck.specs.disk} (${vpsCheck.specs.diskGB} GB)\n` +
          `⚡ CPU: ${vpsCheck.specs.cpu}\n` +
          `🖧 OS: ${vpsCheck.specs.os}\n\n` +
          `✅ Semua spesifikasi memenuhi requirement\n\n` +
          `Silakan pilih OS Windows:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Lanjutkan', callback_data: 'show_dedicated_os_selection' }],
                [{ text: '❌ Batal', callback_data: 'cancel_installation' }]
              ]
            }
          }
        );
      } catch (error) {
        await safeMessageEditor.editMessage(bot, chatId, session.messageId,
          '❌ Gagal terhubung ke VPS. Pastikan IP dan password benar.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Coba Lagi', callback_data: 'install_dedicated_rdp' }],
                [{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]
              ]
            }
          }
        );
        sessionManager.clearUserSession(chatId);
      }
      break;

    case 'waiting_ssh_username':
      session.sshUsername = (msg.text || '').trim();
      if (!session.sshUsername) {
        await safeMessageEditor.editMessage(bot, chatId, session.messageId,
          `❌ Username SSH tidak boleh kosong.\n\nContoh AWS: ubuntu atau ec2-user`,
          { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'cancel_installation' }]] } }
        );
        return;
      }
      session.step = 'waiting_private_key';
      sessionManager.setUserSession(chatId, session);
      await safeMessageEditor.editMessage(bot, chatId, session.messageId,
        `🗝️ Kirim file private key AWS (.pem) sebagai dokumen Telegram.\n\n` +
        `Cara kirim: tekan ikon 📎 → File/Dokumen → pilih file .pem.\n\n` +
        `Kalau tidak bisa kirim file, kamu tetap boleh paste isi key mulai dari:\n` +
        `-----BEGIN ... PRIVATE KEY-----\n\n` +
        `File/pesan akan dihapus otomatis.`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'cancel_installation' }]] } }
      );
      break;

    case 'waiting_private_key':
      session.privateKey = msg.text;
      session.authMethod = 'privateKey';
      session.step = 'checking_vps';
      sessionManager.setUserSession(chatId, session);

      await safeMessageEditor.editMessage(bot, chatId, session.messageId, '🔍 Memeriksa VPS AWS via SSH key...');

      try {
        const vpsCheck = await checkVPSRequirements(session.ip, session.sshUsername || 'ubuntu', null, { privateKey: session.privateKey });
        if (!vpsCheck.success) throw new Error(vpsCheck.error || 'Gagal memeriksa VPS');
        session.rawSpecs = vpsCheck.specs;
        let hostname = vpsCheck.specs.hostname || vpsCheck.specs.hostname_short || 'unknown';
        if (hostname === 'unknown' || !hostname || hostname.trim() === '') hostname = `RDP-${session.ip.split('.').join('')}`;
        session.hostname = hostname;

        if (!vpsCheck.meets_requirements) {
          const reqDetails = vpsCheck.requirements_details;
          await safeMessageEditor.editMessage(bot, chatId, session.messageId,
            `❌ VPS tidak memenuhi spesifikasi minimal\n\n` +
            `🖥️ Spesifikasi VPS saat ini:\n` +
            `${reqDetails.memory.status} RAM: ${reqDetails.memory.current} GB (min: ${reqDetails.memory.required} GB)\n` +
            `${reqDetails.disk.status} Storage: ${reqDetails.disk.current} GB (min: ${reqDetails.disk.required} GB)\n` +
            `${reqDetails.cpu.status} CPU: ${reqDetails.cpu.current} Core (min: ${reqDetails.cpu.required} Core)\n\n` +
            `⚠️ Silakan gunakan VPS dengan spesifikasi yang lebih tinggi.`,
            { reply_markup: { inline_keyboard: [[{ text: '🔄 Coba Lagi', callback_data: 'install_dedicated_rdp' }],[{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]] } }
          );
          sessionManager.clearUserSession(chatId);
          return;
        }

        await safeMessageEditor.editMessage(bot, chatId, session.messageId,
          `🖥️ VPS AWS siap untuk instalasi RDP dedicated\n\n` +
          `🌐 IP Server: ${session.ip}\n` +
          `👤 SSH User: ${session.sshUsername}\n` +
          `🏷️ Hostname: ${session.hostname}\n` +
          `💾 RAM: ${vpsCheck.specs.memory} (${vpsCheck.specs.memoryGB} GB)\n` +
          `💽 Storage: ${vpsCheck.specs.disk} (${vpsCheck.specs.diskGB} GB)\n` +
          `⚡ CPU: ${vpsCheck.specs.cpu}\n` +
          `🖧 OS: ${vpsCheck.specs.os}\n\n` +
          `✅ Login SSH key berhasil\n\n` +
          `Silakan pilih OS Windows:`,
          { reply_markup: { inline_keyboard: [[{ text: '✅ Lanjutkan', callback_data: 'show_dedicated_os_selection' }],[{ text: '❌ Batal', callback_data: 'cancel_installation' }]] } }
        );
      } catch (error) {
        await safeMessageEditor.editMessage(bot, chatId, session.messageId,
          `❌ Gagal terhubung ke VPS AWS. Pastikan IP, username, dan private key benar.\n\n` +
          `Catatan: security group AWS wajib membuka SSH port 22 dari IP bot.`,
          { reply_markup: { inline_keyboard: [[{ text: '🔄 Coba Lagi', callback_data: 'install_dedicated_rdp' }],[{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]] } }
        );
        sessionManager.clearUserSession(chatId);
      }
      break;

    case 'waiting_rdp_password':
      if (msg.text.length < 8 || !/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d@#$%^&+=]{8,}$/.test(msg.text)) {
        await safeMessageEditor.editMessage(bot, chatId, session.messageId,
          '❌ Password tidak memenuhi syarat. Harus minimal 8 karakter dan mengandung huruf dan angka.\n\n' +
          `⚙️ Konfigurasi yang dipilih:\n\n` +
          `💿 OS: ${session.selectedOS.name}\n` +
          `💰 Harga: Rp ${session.selectedOS.price.toLocaleString()}\n\n` +
          `🔑 Masukkan password untuk RDP Windows:\n` +
          `(Min. 8 karakter, kombinasi huruf dan angka)`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Kembali', callback_data: 'back_to_dedicated_os' }]
              ]
            }
          }
        );
        return;
      }

      session.rdpPassword = msg.text;

      await safeMessageEditor.editMessage(bot, chatId, session.messageId,
        '🚀 Memulai instalasi Windows Dedicated...\n\n' +
        '⏰ Proses ini akan memakan waktu 30-45 menit.\n\n' +
        '📊 Status: Instalasi sedang berjalan...\n' +
        '🔔 Catatan: Anda akan mendapat notifikasi ketika RDP siap!'
      );

      try {
        // Potong saldo SEKALI tepat saat instalasi dimulai (idempotent).
        if (!isAdmin(chatId) && session.chargePending) {
          const ok = await deductBalance(chatId, session.installCost || installCost);
          if (!ok) {
            session.chargePending = false;
            sessionManager.setUserSession(chatId, session);
            await safeMessageEditor.editMessage(bot, chatId, session.messageId,
              `❌ Saldo tidak mencukupi untuk memulai instalasi (Rp ${(session.installCost || installCost).toLocaleString('id-ID')}).\nSilakan deposit terlebih dahulu.`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '💳 Deposit', callback_data: 'deposit' }, { text: '🏠 Kembali', callback_data: 'back_to_menu' }]
                  ]
                }
              }
            );
            return;
          }
          session.chargePending = false;
          sessionManager.setUserSession(chatId, session);
        }

        const sshUser = session.authMethod === 'privateKey' ? (session.sshUsername || 'ubuntu') : 'root';
        const sshPassword = session.authMethod === 'privateKey' ? null : session.password;
        const installConfig = {
          osVersion: session.selectedOS.version,
          password: session.rdpPassword
        };
        if (session.authMethod === 'privateKey') {
          installConfig.privateKey = session.privateKey;
          installConfig.useSudo = sshUser !== 'root';
          installConfig.provider = 'aws';
        }

        const installPromise = installDedicatedRDP(session.ip, sshUser, sshPassword, installConfig, (logMessage) => {
          console.log(`[${session.ip}] ${logMessage}`);
        });

        // Jangan biarkan promise installer menjadi unhandled rejection.
        // Monitor tetap berjalan terpisah untuk menunggu port RDP siap.
        installPromise.catch(async (err) => {
          console.error('Dedicated installer error:', err && err.message ? err.message : err);
          try {
            await safeMessageEditor.editMessage(bot, chatId, session.messageId,
              '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.',
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔄 Coba Lagi', callback_data: 'install_dedicated_rdp' }],
                    [{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]
                  ]
                }
              }
            );
          } catch (_) {}
        });

        const monitor = new RDPMonitor(session.ip, 'root', session.password, session.rdpPassword, 4443);

        setTimeout(async () => {
          try {
            await safeMessageEditor.editMessage(bot, chatId, session.messageId,
              '⚙️ Instalasi Windows sedang berlangsung...\n\n' +
              '🔍 Status: Menunggu Windows boot dan RDP siap...\n\n' +
              '📝 Catatan:\n' +
              '• Instalasi berjalan di background\n' +
              '• Anda akan mendapat notifikasi otomatis\n' +
              '• Estimasi: maksimal 15 menit\n' +
              '• Jangan tutup chat ini!'
            );

            // Timeout extended 15 → 25 min. Dedicated installs on
            // non-SGP regions frequently finish 15-22 min in.
            const rdpResult = await monitor.waitForRDPReady(RDP_MONITOR_TIMEOUT_MS, (statusMessage) => {
              console.log(`[${session.ip}] ${statusMessage}`);
            });
            monitor.disconnect();

            if (rdpResult.success && rdpResult.rdpReady) {
              await safeMessageEditor.editMessage(bot, chatId, session.messageId,
                `🎉 RDP Windows SUDAH SIAP DIGUNAKAN!\n\n` +
                `✅ Status: AKTIF dan siap connect\n` +
                `⚡ Response Time: ${rdpResult.responseTime || 'N/A'}ms\n\n` +
                `🖥️ Detail Server:\n` +
                `🏷️ Hostname: ${session.hostname}\n` +
                `💿 OS: ${session.selectedOS.name}\n` +
                `🌐 Server: ${session.ip}:4443\n` +
                `👤 Username: administrator\n` +
                `🔑 Password: ${session.rdpPassword}\n\n` +
                `⏰ Waktu Instalasi: ${rdpResult.totalTime} menit\n` +
                `🔒 Port Custom: 4443 (untuk keamanan)\n\n` +
                `🚀 STATUS: SIAP DIGUNAKAN SEKARANG!`,
                {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '📋 Copy Detail RDP', callback_data: `copy_rdp_${session.ip}_${session.rdpPassword}_${session.hostname}` }],
                      [{ text: '📖 Panduan Koneksi', callback_data: 'rdp_connection_guide' }],
                      [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
                    ]
                  }
                }
              );

              await bot.sendMessage(
                chatId,
                `🎉 Detail Akun RDP Windows - SIAP PAKAI\n\n` +
                `🏷️ Hostname: ${session.hostname}\n` +
                `🌐 Server: ${session.ip}:4443\n` +
                `👤 Username: administrator\n` +
                `🔑 Password: ${session.rdpPassword}\n` +
                `⚡ Response Time: ${rdpResult.responseTime || 'N/A'}ms\n\n` +
                `📖 Cara Koneksi RDP:\n` +
                `1️⃣ Buka Remote Desktop Connection\n` +
                `2️⃣ Masukkan: ${session.ip}:4443\n` +
                `3️⃣ Username: administrator\n` +
                `4️⃣ Password: ${session.rdpPassword}\n` +
                `5️⃣ Connect dan enjoy!\n\n` +
                `💡 Tips Penting:\n` +
                `⚠️ No detect Abuse, Ddos, Exploit Dsb!\n` +
                `⚠️ Support proxy(VPN NOT RECOMMENDED)\n` +
                `⚠️ Jika data sangat penting, mohon rutin backup!!!\n` +
                `⏰ Waktu instalasi: ${rdpResult.totalTime} menit\n\n` +
                `🚀 Server telah diverifikasi dan 100% ready!`,
                {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '📋 Copy Server', callback_data: `copy_server_${session.ip}:4443` }],
                      [{ text: '🔑 Copy Password', callback_data: `copy_pass_${session.rdpPassword}` }],
                      [{ text: '🏷️ Copy Hostname', callback_data: `copy_hostname_${session.hostname}` }]
                    ]
                  }
                }
              );
            } else {
              await safeMessageEditor.editMessage(bot, chatId, session.messageId,
                `❌ Instalasi RDP gagal\n\n` +
                `📊 Status: ${rdpResult.message}\n\n` +
                `🖥️ Detail Server:\n` +
                `🏷️ Hostname: ${session.hostname}\n` +
                `💿 OS: ${session.selectedOS.name}\n` +
                `🌐 IP: ${session.ip}:4443\n` +
                `👤 Username: administrator\n` +
                `🔑 Password: ${session.rdpPassword}\n\n` +
                `⏰ Total Waktu: ${rdpResult.totalTime} menit\n\n` +
                `📋 Langkah Selanjutnya:\n` +
                `Silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.`,
                {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '🔍 Test RDP Manual', callback_data: `test_rdp_${session.ip}_4443` }],
                      [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
                    ]
                  }
                }
              );
            }
          } catch (monitorError) {
            console.error('Error monitoring RDP:', monitorError);

            await safeMessageEditor.editMessage(bot, chatId, session.messageId,
              '❌ Instalasi RDP gagal\n\n' +
              `🖥️ Detail Server:\n` +
              `🏷️ Hostname: ${session.hostname}\n` +
              `💿 OS: ${session.selectedOS.name}\n` +
              `🌐 IP: ${session.ip}:4443\n` +
              `👤 Username: administrator\n` +
              `🔑 Password: ${session.rdpPassword}\n\n` +
              `⏳ Tunggu 15 menit jika masih ada masalah, cek berkala`,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔍 Test RDP Manual', callback_data: `test_rdp_${session.ip}_4443` }],
                    [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
                  ]
                }
              }
            );

            safeMessageEditor.clearMessageCache(chatId, session.messageId);
            sessionManager.clearUserSession(chatId);
          }
        }, 120000);

      } catch (error) {
        console.error('Error instalasi dedicated:', error);

        await safeMessageEditor.editMessage(bot, chatId, session.messageId,
          '❌ Instalasi RDP gagal, silahkan cek menu VPS&RDP Saya lalu lakukan rebuild.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Coba Lagi', callback_data: 'install_dedicated_rdp' }],
                [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
              ]
            }
          }
        );

        safeMessageEditor.clearMessageCache(chatId, session.messageId);
        sessionManager.clearUserSession(chatId);
      }
      break;
  }
}

async function showDedicatedOSSelection(bot, chatId, messageId) {
  if (!DEDICATED_OS_VERSIONS || !Array.isArray(DEDICATED_OS_VERSIONS)) {
    console.error('DEDICATED_OS_VERSIONS tidak terdefinisi atau bukan array');
    await safeMessageEditor.editMessage(bot, chatId, messageId,
      '❌ Terjadi kesalahan sistem. OS versions tidak terdefinisi.',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]
          ]
        }
      }
    );
    return;
  }

  const keyboard = [];
  let messageText = '💿 Pilih OS Windows untuk RDP Dedicated:\n\n(Windows Lite/UEFI disembunyikan karena jarang dipakai)\n\n';
  
  messageText += '🏆 **STANDARD VERSIONS**\n';
  DEDICATED_OS_VERSIONS.filter(os => os.price === 5000 && !os.version.includes('lite') && !os.version.includes('uefi') && os.version !== 'win_10atlas' && os.version !== 'win_2025').forEach(os => {
    let displayName = os.name;
    let buttonText = `${os.id}. ${os.name}`;

    if (os.version === 'win_10atlas') {
      displayName = `${os.name} (AtlasOS)`;
      buttonText = `${os.id}. ${os.name} (AtlasOS)`;
    } else if (os.version === 'win_10ghost') {
      displayName = `${os.name} (Ghost)`;
      buttonText = `${os.id}. ${os.name} (Ghost)`;
    }

    messageText += `${os.id}. ${displayName} - Rp ${os.price.toLocaleString()}\n`;
    keyboard.push([{
      text: buttonText,
      callback_data: `dedicated_os_${os.id}`
    }]);
  });

  keyboard.push([{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]);

  await safeMessageEditor.editMessage(bot, chatId, messageId, messageText, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function handleDedicatedOSSelection(bot, query, sessionManager) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const session = sessionManager.getUserSession(chatId);

  if (!session) {
    await bot.answerCallbackQuery(query.id, {
      text: '⏰ Sesi telah kadaluarsa. Silakan mulai dari awal.',
      show_alert: true
    });
    return;
  }

  const osId = parseInt(query.data.split('_')[2]);
  const selectedOS = DEDICATED_OS_VERSIONS.find(os => os.id === osId);

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

  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `⚙️ Konfigurasi yang dipilih:\n\n` +
    `🏷️ Hostname: ${session.hostname}\n` +
    `💿 OS: ${selectedOS.name}\n` +
    `💰 Harga: Rp ${selectedOS.price.toLocaleString()}\n\n` +
    `🔑 Masukkan password untuk RDP Windows:\n` +
    `(Min. 8 karakter, kombinasi huruf dan angka)`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Kembali', callback_data: 'back_to_dedicated_os' }]
        ]
      }
    }
  );
}


async function handleDedicatedAuthSelection(bot, query, sessionManager) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const session = sessionManager.getUserSession(chatId) || {};

  if (!session || session.installType !== 'dedicated' || session.step !== 'waiting_auth_method') {
    await safeMessageEditor.editMessage(bot, chatId, messageId,
      '⏰ Sesi telah kadaluarsa. Silakan mulai dari awal.',
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]] } }
    );
    return;
  }

  if (query.data === 'dedicated_auth_password') {
    session.authMethod = 'password';
    session.step = 'waiting_password';
    sessionManager.setUserSession(chatId, session);
    await safeMessageEditor.editMessage(bot, chatId, messageId,
      '🔑 Password Root VPS:\nPassword akan dihapus otomatis',
      { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'cancel_installation' }]] } }
    );
    return;
  }

  if (query.data === 'dedicated_auth_key') {
    session.authMethod = 'privateKey';
    session.step = 'waiting_ssh_username';
    sessionManager.setUserSession(chatId, session);
    await safeMessageEditor.editMessage(bot, chatId, messageId,
      `👤 Masukkan username SSH AWS.\n\n` +
      `Contoh umum:\n` +
      `• ubuntu untuk Ubuntu AMI\n` +
      `• ec2-user untuk Amazon Linux\n` +
      `• admin untuk Debian`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'cancel_installation' }]] } }
    );
  }
}

async function handleRDPCallbacks(bot, query, userSessions) {
  const callbackData = query.data;
  const session = userSessions.getUserSession(query.message.chat.id);

  if (callbackData.startsWith('copy_rdp_')) {
    const parts = callbackData.split('_');
    const ip = parts[2];
    const password = parts[3];
    const hostname = parts[4] || 'unknown';

    await bot.answerCallbackQuery(query.id, {
      text: `🎉 RDP Details:\n\n🏷️ Hostname: ${session.hostname}\n🌐 Server: ${ip}:4443\n👤 Username: administrator\n🔑 Password: ${password}\n\n✅  Detail sudah ditampilkan!`, 
      show_alert: true
    });
  }
  else if (callbackData.startsWith('copy_server_')) {
    const server = callbackData.replace('copy_server_', '');

    await bot.answerCallbackQuery(query.id, {
      text: `🌐 Server: ${server}\n\n📋 Copy alamat server ini`,
      show_alert: true
    });
  }
  else if (callbackData.startsWith('copy_pass_')) {
    const password = callbackData.replace('copy_pass_', '');

    await bot.answerCallbackQuery(query.id, {
      text: `🔑 Password: ${password}\n\n📋 Copy password ini`,
      show_alert: true
    });
  }
  else if (callbackData.startsWith('copy_hostname_')) {
    const hostname = callbackData.replace('copy_hostname_', '');

    await bot.answerCallbackQuery(query.id, {
      text: `🏷️ Hostname: ${session.hostname}\n\n📋 Copy hostname ini`,
      show_alert: true
    });
  }
  else if (callbackData === 'rdp_connection_guide') {
    await bot.answerCallbackQuery(query.id, {
      text: '📖 Panduan Koneksi RDP:\n\n1️⃣ Buka Remote Desktop Connection\n2️⃣ Masukkan IP:Port (contoh: 1.2.3.4:4443)\n3️⃣ Username: administrator\n4️⃣ Password: [your password]\n5️⃣ Connect dan enjoy!',
      show_alert: true
    });
  }
  else if (callbackData.startsWith('test_rdp_')) {
    const parts = callbackData.split('_');
    const ip = parts[2];
    const port = parts[3];

    try {
      const monitor = new RDPMonitor(ip, '', '', '', parseInt(port));
      const testResult = await monitor.testRDPConnection();

      await bot.answerCallbackQuery(query.id, {
        text: `🔍 Test RDP ${ip}:${port}\n\n${testResult.success ? '✅ RDP Siap!' : '❌ RDP Belum Siap'}\n\n${testResult.message}`,
        show_alert: true
      });
    } catch (error) {
      await bot.answerCallbackQuery(query.id, {
        text: `❌ Error testing RDP: ${error.message}`,
        show_alert: true
      });
    }
  }
}

module.exports = {
  handleInstallDedicatedRDP,
  showManualCredsPrompt,
  handleDedicatedVPSCredentials,
  showDedicatedOSSelection,
  handleDedicatedOSSelection,
  handleDedicatedAuthSelection,
  handleRDPCallbacks
};