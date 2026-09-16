/**
 * Shared helpers for the RDP install/rebuild flows:
 *   - RDP_MONITOR_TIMEOUT_MS: single source of truth for how long the bot
 *     waits for port 4443 to come up. Bumped from 15 min → 25 min after
 *     multiple reports of "Instalasi gagal" appearing on Linode non-SGP
 *     regions where Windows genuinely needs longer than 15 minutes.
 *   - validateWindowsPassword: enforces Windows password complexity for
 *     the "custom password" wizard.
 *   - buildTimeoutCard / buildTimeoutCardMarkdown: the "monitoring timeout
 *     but here's your password anyway — try connecting before rebuilding"
 *     message. Kept centralized so every install flow shows the same
 *     wording.
 */

// 40 minutes. Timeline setelah bot SSH selesai run tele.sh:
//   - tele.sh setup GRUB entry + reboot (near instant)
//   - Alpine mini-installer boot + download Windows image (~5GB): 5-12 min
//   - Alpine DD image to disk: ~1 min
//   - Alpine reboot to Windows (drives, sysprep, first boot): 5-15 min
//   - Windows fully boot + RDP service listen: total ~15-30 min post-reboot
// UpCloud specifically slower karena template pertama kali download bisa
// susah reach mirror; bumped dari 25 -> 40 min supaya user tidak keburu
// nyerah / bot false negative. Kalau setelah 40 min port 4443 masih timeout,
// itu memang install gagal (biasanya UEFI/BIOS mismatch atau image corrupt).
const RDP_MONITOR_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * Windows RDP password requirements (RDP + Windows local account):
 *   - 8..30 chars (Windows local account cap is 127 but 30 is our UX cap)
 *   - no whitespace
 *   - at least 2 of: uppercase, lowercase, digit
 *
 * We intentionally do NOT require a symbol because the Windows install
 * script sets the password via `net user` which is sensitive to some
 * special chars in cmd/PowerShell escaping. Letters + digits is safest.
 */
function validateWindowsPassword(pass) {
  if (typeof pass !== 'string') return { ok: false, error: 'Password harus berupa teks.' };
  const p = pass;
  if (p.length < 8) return { ok: false, error: 'Password minimal 8 karakter.' };
  if (p.length > 30) return { ok: false, error: 'Password maksimal 30 karakter.' };
  if (/\s/.test(p)) return { ok: false, error: 'Password tidak boleh mengandung spasi.' };
  // Disallow characters that break cmd/PowerShell escaping in the installer.
  if (/[`"\\'&|<>%$]/.test(p)) {
    return { ok: false, error: 'Password mengandung karakter yang tidak diperbolehkan (` " \\ \' & | < > % $).' };
  }
  const hasUpper = /[A-Z]/.test(p);
  const hasLower = /[a-z]/.test(p);
  const hasDigit = /[0-9]/.test(p);
  const score = [hasUpper, hasLower, hasDigit].filter(Boolean).length;
  if (score < 2) {
    return { ok: false, error: 'Password harus kombinasi minimal 2 dari: huruf besar (A-Z), huruf kecil (a-z), angka (0-9).' };
  }
  return { ok: true };
}

/**
 * Timeout card factory. Used when `waitForRDPReady` returns rdpReady=false
 * but the password IS already saved. We show the user their credentials
 * plus explicit guidance: try connecting first, only rebuild if that
 * fails.
 *
 * Returns a Markdown-safe string (single caller can wrap in
 * parse_mode='Markdown' safely — backticks quote user-visible values).
 */
function buildTimeoutCardMarkdown({ ip, port = 4443, hostname, osName, region, password, elapsedMin }) {
  const bt = '`';
  return (
    `⚠️ *Monitoring RDP timeout setelah ${elapsedMin || 40} menit*\n\n` +
    `Ini *bukan berarti install gagal*. Kadang RDP baru siap sedikit lebih lama.\n\n` +
    `📋 *Coba dulu langkah ini SEBELUM rebuild:*\n` +
    `1️⃣ Tunggu 2-5 menit lagi\n` +
    `2️⃣ Buka Remote Desktop\n` +
    `3️⃣ Isi: ${bt}${ip}:${port}${bt}\n` +
    `4️⃣ Username: ${bt}administrator${bt}\n` +
    `5️⃣ Password: ${bt}${password}${bt}\n\n` +
    (hostname ? `🏷️ Hostname: ${bt}${hostname}${bt}\n` : '') +
    (region ? `📍 Region: ${bt}${region}${bt}\n` : '') +
    (osName ? `🪟 Windows: ${bt}${osName}${bt}\n` : '') +
    `\n🔍 *Kalau masih timeout:* buka console VPS di panel cloud provider ` +
    `(UpCloud: hub.upcloud.com, DO: cloud.digitalocean.com, AWS: EC2 Instance Connect) ` +
    `untuk cek status Windows install / boot.\n\n` +
    `💡 Kalau setelah 10 menit masih *belum bisa connect*, baru rebuild di menu VPS&RDP Saya.`
  );
}

/**
 * Common inline keyboard for the timeout card. Callbacks reuse existing
 * copy_* handlers already wired in index.js.
 */
function buildTimeoutCardKeyboard({ ip, port = 4443, password }) {
  return {
    inline_keyboard: [
      [{ text: '📋 Copy Server', callback_data: `copy_server_${ip}:${port}` }],
      [{ text: '📋 Copy Password', callback_data: `copy_pass_${password}` }],
      [{ text: '📁 VPS&RDP Saya', callback_data: 'my_services' }],
      [{ text: '🏠 Kembali ke Menu', callback_data: 'back_to_menu' }]
    ]
  };
}

module.exports = {
  RDP_MONITOR_TIMEOUT_MS,
  validateWindowsPassword,
  buildTimeoutCardMarkdown,
  buildTimeoutCardKeyboard
};
