/**
 * Premium-only renter flows: Install Cloud9 / Fastpanel manually to a
 * renter-supplied VPS, or auto-create a VPS via the renter's own cloud API
 * and install Cloud9 / Fastpanel on it.
 *
 * All of these are GATED behind Renter Premium tier (see requirePremiumRenter
 * in renterHandler.js). The renter pays for the sewa bot subscription once,
 * and then gets unlimited use of these install / auto-order flows — the
 * underlying VPS resource cost stays on the renter's own cloud account.
 */

const crypto = require('crypto');
const safeMessageEditor = require('../utils/safeMessageEdit');
const renterManager = require('../utils/renterManager');
const {
  getSizesForRegion, getRegions, createDroplet, waitPublicIp, deleteDroplet,
  isAwsToken, isLinodeToken, providerName
} = require('../utils/doApi');
const { installCloud9 } = require('../utils/cloud9Installer');
const { installFastpanel } = require('../utils/fastpanelInstaller');

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function genAlphaNum(n = 14) {
  const raw = crypto.randomBytes(48).toString('base64').replace(/[/+=]/g, '');
  return raw.slice(0, Math.max(10, Number(n) || 14));
}

function genCloud9Pass() {
  const raw = crypto.randomBytes(24).toString('base64').replace(/[/+=]/g, '');
  return `C9${raw.slice(0, 14)}!9`;
}

function genFastpanelPass() {
  const raw = crypto.randomBytes(24).toString('base64').replace(/[/+=]/g, '');
  return `Fp${raw.slice(0, 14)}!9`;
}

function rootCloudInit(password) {
  return `#cloud-config
ssh_pwauth: true
disable_root: false
chpasswd:
  list: |
    root:${password}
  expire: false
write_files:
  - path: /etc/ssh/sshd_config.d/99-root-password.conf
    permissions: '0644'
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
      KbdInteractiveAuthentication yes
runcmd:
  - [ sh, -lc, "set -e; (grep -q '^PermitRootLogin' /etc/ssh/sshd_config && sed -i 's/^PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config); (grep -q '^PasswordAuthentication' /etc/ssh/sshd_config && sed -i 's/^PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config); (grep -q '^KbdInteractiveAuthentication' /etc/ssh/sshd_config && sed -i 's/^KbdInteractiveAuthentication.*/KbdInteractiveAuthentication yes/' /etc/ssh/sshd_config || echo 'KbdInteractiveAuthentication yes' >> /etc/ssh/sshd_config); systemctl restart ssh || systemctl restart sshd || service ssh restart || true" ]
`;
}

// Pick a default Ubuntu image slug per provider. Cloud9 and Fastpanel both
// need Ubuntu 22.04 as their supported base.
function ubuntuImageForToken(token) {
  if (isAwsToken(token)) return 'aws:ubuntu22.04';
  if (isLinodeToken(token)) return 'linode/ubuntu22.04';
  return 'ubuntu-22-04-x64';
}

function apiLabel(a) {
  return `${a.provider || 'DigitalOcean'} API#${a.id} • ${a.email || '-'}`;
}

/**
 * Small helper: show API picker or auto-select if the renter only has one
 * active API. `product` = 'c9' | 'fp' to keep callback prefixes disjoint.
 */
async function pickApiOrAuto(bot, chatId, messageId, product, sessionManager, autoHandler) {
  const apis = await renterManager.listApis(chatId, true);
  if (!apis.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '❌ Tambahkan API DigitalOcean/Linode/AWS aktif dulu di menu API Cloud.',
      { reply_markup: { inline_keyboard: [
        [{ text: '🔑 API Cloud', callback_data: 'renter_api_menu' }],
        [{ text: '« Kembali', callback_data: 'renter_menu' }]
      ] } });
  }
  if (apis.length === 1) return autoHandler(apis[0].id);
  const kb = apis.map(a => ([{ text: apiLabel(a), callback_data: `renter_${product}_api:${a.id}` }]));
  kb.push([{ text: '« Kembali', callback_data: 'renter_menu' }]);
  const productLabel = product === 'c9' ? 'Cloud9' : 'Fastpanel';
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    `Pilih API untuk buat ${productLabel}:`,
    { reply_markup: { inline_keyboard: kb } }
  );
}

/* -------------------------------------------------------------------------- */
/*  MANUAL INSTALL FLOWS (SSH into renter-provided IP + creds)                */
/* -------------------------------------------------------------------------- */

async function startManualInstall(bot, chatId, messageId, product, sessionManager) {
  const productLabel = product === 'c9' ? 'Cloud9 IDE' : 'Fastpanel';
  const sessKey = product === 'c9' ? 'renter_c9_manual' : 'renter_fp_manual';
  const reqLine = product === 'c9'
    ? '• OS: Ubuntu 20.04/22.04/24.04 atau Debian 10/11/12 (fresh install)\n• RAM minimal 512MB'
    : '• OS: Ubuntu 20.04/22.04/24.04 atau Debian 10/11/12 (fresh install)\n• Belum ada nginx/apache/mysql yang jalan\n• RAM minimal 1GB (rekomendasi 2GB)';

  const msg = await safeMessageEditor.editMessage(bot, chatId, messageId,
    `🛠️ *Install ${productLabel}* (Premium)\n\n` +
    `Bot akan SSH ke VPS kamu dan install ${productLabel} otomatis.\n\n` +
    `📌 Syarat VPS:\n${reqLine}\n\n` +
    `Kirim IP VPS:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Batal', callback_data: 'renter_menu' }]] } }
  );

  sessionManager.setUserSession(chatId, {
    installType: sessKey,
    step: 'waiting_ip',
    product,
    messageId: msg?.message_id || messageId
  });
}

async function processManualInstall(bot, msg, sessionManager) {
  const chatId = msg.chat.id;
  const session = sessionManager.getUserSession(chatId);
  if (!session) return false;
  if (session.installType !== 'renter_c9_manual' && session.installType !== 'renter_fp_manual') return false;

  const isC9 = session.installType === 'renter_c9_manual';
  const productLabel = isC9 ? 'Cloud9 IDE' : 'Fastpanel';

  // Delete the incoming message immediately so the credentials (later)
  // don't sit next to the IP/pass the user typed.
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}

  if (session.step === 'waiting_ip') {
    const ip = String(msg.text || '').trim();
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      await bot.sendMessage(chatId, '❌ IP tidak valid. Kirim IP VPS yang benar.');
      return true;
    }
    session.ip = ip;
    session.step = 'waiting_user';
    sessionManager.setUserSession(chatId, session);
    await bot.sendMessage(chatId, 'Kirim username SSH VPS, biasanya `root`:', { parse_mode: 'Markdown' });
    return true;
  }

  if (session.step === 'waiting_user') {
    session.username = String(msg.text || '').trim() || 'root';
    session.step = 'waiting_pass';
    sessionManager.setUserSession(chatId, session);
    await bot.sendMessage(chatId, 'Kirim password SSH VPS:');
    return true;
  }

  if (session.step === 'waiting_pass') {
    session.password = String(msg.text || '').trim();
    sessionManager.clearUserSession(chatId);

    const status = await bot.sendMessage(chatId,
      `⏳ Instalasi ${productLabel} dimulai di ${session.ip}. Estimasi ${isC9 ? '5-10' : '8-15'} menit...`
    );

    try {
      let result;
      if (isC9) {
        // Cloud9 installer takes no override options — it parses whatever
        // `scripts/x9.sh` prints (SUCCESS / PORT / C9_USER / C9_PASS).
        result = await installCloud9(session.ip, session.username, session.password, {},
          (line) => console.log(`[RENTER C9 ${session.ip}] ${line}`));
      } else {
        const fpPass = genFastpanelPass();
        result = await installFastpanel(session.ip, session.username, session.password, {
          fastpanelUser: 'fastuser',
          fastpanelPassword: fpPass
        }, (line) => console.log(`[RENTER FP ${session.ip}] ${line}`));
      }

      const port = result.port || (isC9 ? '8000' : '8888');
      const url = result.url || (isC9 ? `http://${session.ip}:${port}/` : `https://${session.ip}:${port}/`);
      const user = result.username || (isC9 ? 'Admin' : 'fastuser');
      const pass = result.password;

      // Log the install as a renter instance so it appears in "VPS&RDP Saya".
      await renterManager.saveInstance({
        userId: chatId,
        type: isC9 ? 'cloud9' : 'fastpanel',
        dropletId: null,
        ip: session.ip,
        sizeSlug: null,
        region: null,
        image: (isC9 ? 'cloud9:manual' : 'fastpanel:manual'),
        rootPassword: session.password,
        rdpPassword: null,
        windowsVersion: null,
        apiId: null
      });

      await bot.sendMessage(chatId,
        `✅ *INSTALL ${productLabel.toUpperCase()} SELESAI!*\n` +
        `🌐 URL: ${url}\n` +
        `👤 Username: \`${user}\`\n` +
        `🔑 Password: \`${pass}\`\n` +
        `🔒 Port: ${port}\n\n` +
        (isC9 ? '' : '⚠️ Panel pakai SSL self-signed, browser akan warning. Klik "Advanced → Proceed".'),
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      const raw = String(e?.message || e || 'unknown').slice(0, 3500);
      await bot.sendMessage(chatId,
        `❌ Install ${productLabel} gagal.\nReason:\n${raw}`
      );
    }
    try { await bot.deleteMessage(chatId, status.message_id); } catch (_) {}
    return true;
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/*  AUTO-CREATE FLOWS (create VPS via renter's API then install)              */
/* -------------------------------------------------------------------------- */

async function startCreate(bot, chatId, messageId, product, sessionManager) {
  return pickApiOrAuto(bot, chatId, messageId, product, sessionManager,
    (apiId) => pickRegion(bot, chatId, messageId, product, apiId, sessionManager));
}

async function pickRegion(bot, chatId, messageId, product, apiId, sessionManager) {
  const token = await renterManager.getApiToken(chatId, apiId);
  if (!token) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      '❌ API tidak aktif / tidak ditemukan.',
      { reply_markup: { inline_keyboard: [[{ text: '🔑 API Cloud', callback_data: 'renter_api_menu' }]] } });
  }

  sessionManager.setAdminSession(chatId, {
    action: `renter_${product}_create`,
    apiId: Number(apiId),
    messageId
  });

  const regions = await getRegions(token);
  if (!regions.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      `❌ Tidak ada region ${providerName(token)} tersedia.`,
      { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'renter_menu' }]] } });
  }

  const productLabel = product === 'c9' ? 'Cloud9' : 'Fastpanel';
  const kb = regions.slice(0, 60).map(r => ([{
    text: `${r.slug} (${r.name})`,
    callback_data: `renter_${product}_regionpick:${apiId}:${r.slug}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'renter_menu' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId,
    `🌍 Pilih region untuk ${productLabel}:`,
    { reply_markup: { inline_keyboard: kb } }
  );
}

async function pickSize(bot, chatId, messageId, product, apiId, region, sessionManager, page = 0) {
  const token = await renterManager.getApiToken(chatId, apiId);
  if (!token) return bot.sendMessage(chatId, '❌ API tidak aktif / tidak ditemukan.');

  const sizes = await getSizesForRegion(token, region);
  if (!sizes.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId,
      `❌ Tidak ada size tersedia di region *${region}*.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '« Pilih Region Lain', callback_data: `renter_${product}_api:${apiId}` }],
        [{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]
      ] } });
  }

  const session = sessionManager.getAdminSession(chatId) || {};
  session.action = `renter_${product}_create`;
  session.apiId = Number(apiId);
  session.region = region;
  session.messageId = messageId;
  sessionManager.setAdminSession(chatId, session);

  // Filter min RAM: Fastpanel needs 1GB+, Cloud9 fine at 512MB but recommend 1GB.
  const minRam = product === 'fp' ? 1024 : 512;
  const filtered = sizes.filter(s => Number(s.memory || 0) >= minRam);
  const list = filtered.length ? filtered : sizes;

  const perPage = 12;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const p = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const kb = list.slice(p * perPage, (p + 1) * perPage).map(s => ([{
    text: `${s.slug} • ${Math.round(Number(s.memory || 0) / 1024)}GB RAM / ${s.vcpus} CPU`,
    callback_data: `renter_${product}_sizepick:${apiId}:${region}:${s.slug}`
  }]));

  const nav = [];
  if (p > 0) nav.push({ text: '⬅️ Prev', callback_data: `renter_${product}_sizepage:${apiId}:${region}:${p - 1}` });
  if (p < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `renter_${product}_sizepage:${apiId}:${region}:${p + 1}` });
  if (nav.length) kb.push(nav);
  kb.push([{ text: '« Kembali ke Region', callback_data: `renter_${product}_api:${apiId}` }]);

  const productLabel = product === 'c9' ? 'Cloud9' : 'Fastpanel';
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    `📦 Pilih spesifikasi ${productLabel} di region *${region}*:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }
  );
}

/**
 * Actually create the droplet, wait for SSH, run installer, save instance,
 * and report credentials. Called from the sizepick callback.
 */
async function create(bot, chatId, messageId, product, apiId, region, sizeSlug) {
  const isC9 = product === 'c9';
  const productLabel = isC9 ? 'Cloud9 IDE' : 'Fastpanel';
  const token = await renterManager.getApiToken(chatId, apiId);
  if (!token) return bot.sendMessage(chatId, '❌ API tidak aktif / tidak ditemukan.');

  const rootPassword = genAlphaNum(12);
  const image = ubuntuImageForToken(token);
  const cloudInit = rootCloudInit(rootPassword);
  const name = `renter-${product}-${chatId}-${crypto.randomBytes(3).toString('hex')}`;

  await safeMessageEditor.editMessage(bot, chatId, messageId,
    `⏳ VPS untuk ${productLabel} sedang dibuat...\n\n` +
    `Provider: ${providerName(token)}\n` +
    `Size: ${sizeSlug}\n` +
    `Region: ${region}\n\n` +
    `Estimasi total: ~${isC9 ? '10-15' : '15-20'} menit sampai siap.`,
    { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Renter', callback_data: 'renter_menu' }]] } }
  );

  let dropletId = null;
  try {
    const created = await createDroplet(token, name, region, sizeSlug, image, cloudInit);
    dropletId = created.dropletId;
    if (!dropletId) throw new Error(created.error || 'Gagal membuat instance.');

    const ip = await waitPublicIp(token, dropletId, 40, 10000, region);
    if (!ip) throw new Error('IP publik VPS belum tersedia.');

    await bot.sendMessage(chatId, `✅ VPS berhasil dibuat: \`${ip}\`\n⏳ Menunggu SSH dan install ${productLabel}...`, { parse_mode: 'Markdown' });

    let result;
    if (isC9) {
      // Cloud9 installer uses the `x9.sh` script defaults (user Admin, port 8000).
      result = await installCloud9(ip, 'root', rootPassword, {
        sshMaxWaitMs: 12 * 60 * 1000
      }, (line) => console.log(`[RENTER C9 CREATE ${ip}] ${line}`));
    } else {
      const fpPass = genFastpanelPass();
      result = await installFastpanel(ip, 'root', rootPassword, {
        fastpanelUser: 'fastuser',
        fastpanelPassword: fpPass,
        sshMaxWaitMs: 12 * 60 * 1000
      }, (line) => console.log(`[RENTER FP CREATE ${ip}] ${line}`));
    }

    const port = result.port || (isC9 ? '8000' : '8888');
    const url = result.url || (isC9 ? `http://${ip}:${port}/` : `https://${ip}:${port}/`);
    const user = result.username || (isC9 ? 'Admin' : 'fastuser');
    const pass = result.password;

    await renterManager.saveInstance({
      userId: chatId,
      type: isC9 ? 'cloud9' : 'fastpanel',
      dropletId,
      ip,
      sizeSlug,
      region,
      image: (isC9 ? `cloud9:${image}` : `fastpanel:${image}`),
      rootPassword,
      rdpPassword: null,
      windowsVersion: null,
      apiId
    });

    return bot.sendMessage(chatId,
      `✅ *${productLabel.toUpperCase()} SIAP!*\n` +
      `🌐 URL     : ${url}\n` +
      `👤 User    : \`${user}\`\n` +
      `🔑 Password: \`${pass}\`\n` +
      `🔒 Port    : ${port}\n` +
      `📝 IP VPS  : \`${ip}\`\n` +
      `📝 SSH root: \`${rootPassword}\`\n\n` +
      (isC9 ? '' : '⚠️ Panel pakai SSL self-signed. Browser akan warning — klik "Advanced → Proceed".'),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    if (dropletId) {
      try { await deleteDroplet(token, dropletId, region); } catch (_) {}
    }
    const raw = String(e?.message || e || 'unknown').slice(0, 3500);
    return bot.sendMessage(chatId, `❌ Buat ${productLabel} gagal.\nReason:\n${raw}`);
  }
}

module.exports = {
  startManualInstall,
  processManualInstall,
  startCreate,
  pickRegion,
  pickSize,
  create
};
