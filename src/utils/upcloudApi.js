/**
 * UpCloud adapter untuk bot GABUT.
 *
 * Endpoint contract yang di-wrap (dari https://developers.upcloud.com/1.3/):
 *   GET    /1.3/account                              -> auth probe
 *   GET    /1.3/zone                                 -> list zones (regions)
 *   GET    /1.3/plan                                 -> list plans (1xCPU-2GB, dst)
 *   GET    /1.3/server_size                          -> list custom size combos
 *   GET    /1.3/storage/template                     -> public OS templates
 *   POST   /1.3/server                               -> create server (async)
 *   GET    /1.3/server/{uuid}                        -> server state + IP
 *   POST   /1.3/server/{uuid}/start                  -> boot
 *   POST   /1.3/server/{uuid}/stop                   -> shutdown
 *   POST   /1.3/server/{uuid}/restart                -> reboot
 *   DELETE /1.3/server/{uuid}?storages=1             -> terminate + hapus disk
 *   POST   /1.3/server/{uuid}/firewall_rule          -> add firewall rule
 *   PUT    /1.3/server/{uuid}                        -> update server (set firewall off)
 *
 * Auth: Authorization: Bearer ucat_xxxx  (bearer token dari UpCloud)
 *
 * Behavior spesifik yang bot butuhkan:
 * - Base OS = Ubuntu 22.04 dari public template (auto-discovery UUID)
 * - Auto-root via cloud-init user_data (kompatibel dgn rootCloudInit dari handler)
 * - Disk auto-size by RAM (RAM 8GB -> 160GB, RAM 16GB -> 300GB, dst)
 * - Firewall = "on" + accept-all rules (IPv4 + IPv6, direction=in, protocol=empty=any)
 *   Fallback: kalau add rule gagal, PUT firewall=off supaya SSH tetap work
 */

const axios = require('axios');
const crypto = require('crypto');
const { Client: SshClient } = require('ssh2');

const UPCLOUD_API = 'https://api.upcloud.com/1.3';

// Adapter disk OS untuk server yang dibuat bot. Default IDE karena paling
// universal untuk DD Windows image (bin456789/reinstall). Override via env
// UPCLOUD_DISK_ADAPTER = ide | virtio | scsi.
// Format address UpCloud: "ide:0:0" (primary master), "virtio:0", "scsi:0:0".
function _diskAddress() {
  const adapter = String(process.env.UPCLOUD_DISK_ADAPTER || 'ide').toLowerCase().trim();
  switch (adapter) {
    case 'virtio':
      return 'virtio:0';
    case 'scsi':
      return 'scsi:0:0';
    case 'ide':
    default:
      return 'ide:0:0';
  }
}

// ============================================================================
// SSH keypair generation
// ============================================================================
// UpCloud docs (section 8. Servers) menyatakan:
//   "ssh_keys are also the only login method for cloud-init enabled templates
//   - one cannot create a password for these templates."
//
// Karena Ubuntu 22.04 UpCloud template = cloud-init template, satu-satunya
// cara yang JAMIN bot bisa SSH ke server baru adalah lewat SSH key auth.
// Password via `chpasswd` di user_data kadang jalan tapi race dengan sshd
// yang sudah listen — bot fail auth sebelum cloud-init selesai.
//
// Solusi: generate ephemeral RSA keypair per server, kirim public key ke
// `login_user.ssh_keys` (di-inject langsung ke /root/.ssh/authorized_keys
// oleh UpCloud), lalu bot pakai private key untuk SSH awal + jalankan tele.sh.
function _generateSshKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, // ssh2 accepts PKCS#1 PEM
  });

  // Convert SPKI-DER public key ke OpenSSH "ssh-rsa AAAA..." format
  // (format yang UpCloud butuhkan untuk login_user.ssh_keys).
  const pubKeyObj = crypto.createPublicKey({
    key: publicKey,
    format: 'der',
    type: 'spki',
  });
  const jwk = pubKeyObj.export({ format: 'jwk' }); // { n, e } base64url
  const nBytes = Buffer.from(jwk.n, 'base64url');
  const eBytes = Buffer.from(jwk.e, 'base64url');

  function encodeString(buf) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length, 0);
    return Buffer.concat([len, buf]);
  }
  function encodeMpint(buf) {
    // mpint format: kalau MSB bytenya ada high bit (>= 0x80), prefix 0x00
    // supaya di-parse sebagai positive integer.
    if (buf.length > 0 && (buf[0] & 0x80)) {
      buf = Buffer.concat([Buffer.from([0]), buf]);
    }
    return encodeString(buf);
  }

  const sshPubBody = Buffer.concat([
    encodeString(Buffer.from('ssh-rsa')),
    encodeMpint(eBytes),
    encodeMpint(nBytes),
  ]);
  const sshPublicKey = 'ssh-rsa ' + sshPubBody.toString('base64') + ' bot@gabut-upcloud';

  return {
    publicKeySsh: sshPublicKey, // dikirim ke UpCloud
    privateKeyPem: privateKey, // dipakai bot untuk SSH
  };
}

// UUID template Ubuntu 22.04 LTS dari UpCloud (dikonfirmasi di doc official
// section 9. Storages). Konstan across all accounts, jadi bisa di-hardcode
// sebagai fast-path (skip API call GET /storage/template).
// Fallback: discovery dinamis di findUbuntu2204TemplateUuid() kalau UUID
// ini suatu hari di-deprecate UpCloud.
const UBUNTU_22_04_UUID = '01000000-0000-4000-8000-000030220200';

// ============================================================================
// Token detection
// ============================================================================
// Format token dari UpCloud dashboard: "ucat_" + huruf/angka.
// Contoh dari screenshot: ucat_01DQE3AJDEBFEKECFM558TGH2F...
// Pattern minimal 16 char body supaya tidak false-positive terhadap string pendek.
function isUpCloudToken(token) {
  const t = String(token || '').trim();
  return /^ucat_[A-Za-z0-9]{16,}$/i.test(t);
}

function upcloudHeaders(token) {
  return {
    Authorization: `Bearer ${String(token || '').trim()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// ============================================================================
// Disk auto-size by RAM
// ============================================================================
// Berdasarkan patokan user: RAM 8GB -> 160GB, RAM 16GB -> 300GB.
// Step function biar predictable dan bot tidak error karena disk terlalu kecil
// (Windows Server butuh minimal ~40GB, plus growth).
function pickDiskGb(memoryMb) {
  const ramGb = Math.round(Number(memoryMb || 0) / 1024);
  // Patokan user:
  //   RAM 8GB  -> 250GB
  //   RAM 16GB -> 350GB
  //   RAM 24GB -> 450GB
  // Skala di atas & bawah menyesuaikan supaya tidak error karena disk kurang
  // (Windows Server butuh minimal ~40GB) tapi juga tidak boros untuk RAM kecil.
  if (ramGb <= 1)   return 50;
  if (ramGb <= 2)   return 100;
  if (ramGb <= 4)   return 150;
  if (ramGb <= 8)   return 250;   // <-- patokan user
  if (ramGb <= 12)  return 300;
  if (ramGb <= 16)  return 350;   // <-- patokan user
  if (ramGb <= 24)  return 450;   // <-- patokan user
  if (ramGb <= 32)  return 600;
  if (ramGb <= 64)  return 1000;
  if (ramGb <= 128) return 1600;
  return Math.max(1600, ramGb * 15);
}

// ============================================================================
// Cloud-init builder (UpCloud-specific, kompatibel cloud-init 22.x + 23.x)
// ============================================================================
/**
 * Parse root password dari cloud-init user_data string.
 * Support 3 format:
 *   1. "root:<pass>" (dari chpasswd.list — pattern rootCloudInit lama)
 *   2. "password: <pass>" (cloud-config top-level)
 *   3. chpasswd.users[].password
 * Kalau tidak ketemu, fallback ke default (jarang terjadi).
 */
function _parseRootPassword(userData) {
  const s = String(userData || '');
  let m;
  // Pattern 1: chpasswd.list -> "root:PASSWORD"
  m = s.match(/root:([^\n\r]+)/);
  if (m) return m[1].trim();
  // Pattern 2: top-level "password: PASSWORD"
  m = s.match(/^password:\s*([^\n\r]+)/m);
  if (m) return m[1].trim();
  // Pattern 3: chpasswd.users[].password
  m = s.match(/password:\s*([^\n\r]+)\s*\n/);
  if (m) return m[1].trim();
  return `UpcloudDefault${Date.now()}!`; // fallback safety net
}

/**
 * Build cloud-init YAML yang bulletproof untuk UpCloud Ubuntu 22.04 template.
 * Pakai 3 mekanisme redundan untuk set root password:
 *   1. chpasswd.users (new syntax, cloud-init 22.2+)
 *   2. chpasswd.list (old syntax, backward compat)
 *   3. runcmd: echo | chpasswd (bulletproof, no cloud-init dependency)
 * Plus disable ufw supaya SSH tidak di-block OS-level.
 */
function _buildUpcloudCloudInit(rootPassword) {
  // Escape single quote untuk POSIX shell (kalau nanti password ada quote,
  // walau saat ini genAlphaNum tidak generate quote — ini defensive).
  const pass = String(rootPassword || '').replace(/'/g, "'\\''");

  // CRITICAL: OpenSSH sshd_config.d aturan "first-match wins" — file di
  // /etc/ssh/sshd_config.d/*.conf di-include ALPHABETICAL, dan value pertama
  // untuk setiap keyword yang menang. UpCloud Ubuntu 22.04 template biasanya
  // ship dengan drop-in seperti `50-cloud-init.conf` yang set
  // `PasswordAuthentication no` (karena kita inject login_user.ssh_keys,
  // cloud-init otomatis kunci password auth).
  //
  // Solusi 3-lapis:
  //   1. write_files ke `/etc/ssh/sshd_config.d/00-bot-override.conf` supaya
  //      load PALING DULU (00 < 50) dan menang di first-match wins.
  //   2. runcmd sed edit main sshd_config sebagai source of truth.
  //   3. runcmd loop nuke SEMUA drop-in file lain yang set
  //      `PasswordAuthentication no` / `PermitRootLogin no|prohibit-password`.
  //   4. Restart sshd setelah semua perubahan.
  //
  // Kita pakai YAML block scalar (- |) untuk runcmd supaya bebas dari
  // YAML escape hell (double-quoted YAML tidak accept `\s` sebagai
  // escape sequence -> PyYAML error).
  return `#cloud-config
ssh_pwauth: true
disable_root: false
chpasswd:
  expire: false
  list: |
    root:${rootPassword}
  users:
    - name: root
      password: ${rootPassword}
      type: text
write_files:
  - path: /etc/ssh/sshd_config.d/00-bot-override.conf
    permissions: '0644'
    content: |
      # WRITTEN BY GABUT BOT - enable root+password auth for user access
      PermitRootLogin yes
      PasswordAuthentication yes
      KbdInteractiveAuthentication yes
      ChallengeResponseAuthentication yes
      UsePAM yes
runcmd:
  - |
    set +e
    LOG=/var/log/bot-cloudinit.log
    echo "[bot-cloudinit] starting override at $(date -Is)" >> "$LOG"
    # 1. Set root password (belt-and-suspenders)
    echo 'root:${pass}' | chpasswd >>"$LOG" 2>&1
    # 2. Fix main sshd_config (source of truth)
    sed -i -E 's/^#?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
    grep -qE '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config
    sed -i -E 's/^#?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
    grep -qE '^PasswordAuthentication' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config
    sed -i -E 's/^#?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication yes/' /etc/ssh/sshd_config
    # 3. NUKE any sshd_config.d drop-in that disables password auth
    #    (UpCloud template ships 50-cloud-init.conf with PasswordAuthentication no)
    mkdir -p /etc/ssh/sshd_config.d
    for f in /etc/ssh/sshd_config.d/*.conf; do
      [ -f "$f" ] || continue
      [ "$f" = "/etc/ssh/sshd_config.d/00-bot-override.conf" ] && continue
      echo "[bot-cloudinit] patching $f" >> "$LOG"
      sed -i -E 's/^[[:space:]]*#?[[:space:]]*PasswordAuthentication[[:space:]]+no/PasswordAuthentication yes/gI' "$f"
      sed -i -E 's/^[[:space:]]*#?[[:space:]]*PermitRootLogin[[:space:]]+no/PermitRootLogin yes/gI' "$f"
      sed -i -E 's/^[[:space:]]*#?[[:space:]]*PermitRootLogin[[:space:]]+prohibit-password/PermitRootLogin yes/gI' "$f"
      sed -i -E 's/^[[:space:]]*#?[[:space:]]*KbdInteractiveAuthentication[[:space:]]+no/KbdInteractiveAuthentication yes/gI' "$f"
      sed -i -E 's/^[[:space:]]*#?[[:space:]]*ChallengeResponseAuthentication[[:space:]]+no/ChallengeResponseAuthentication yes/gI' "$f"
    done
    # 4. Disable OS-level firewall (belt-and-suspenders since UpCloud L3 firewall
    #    is default-accept; ufw would only block if user's image enables it).
    ufw disable >>"$LOG" 2>&1 || true
    iptables -F 2>>"$LOG" || true
    systemctl stop ufw >>"$LOG" 2>&1 || true
    systemctl disable ufw >>"$LOG" 2>&1 || true
    # 5. Verify sshd config valid, then restart. If -t fails, DO NOT restart
    #    (would break the running sshd and lock user out).
    if sshd -t 2>>"$LOG"; then
      systemctl restart ssh >>"$LOG" 2>&1 || systemctl restart sshd >>"$LOG" 2>&1 || service ssh restart >>"$LOG" 2>&1 || true
      echo "[bot-cloudinit] sshd restarted OK" >> "$LOG"
    else
      echo "[bot-cloudinit] WARNING: sshd -t FAILED, not restarting" >> "$LOG"
    fi
    echo "[bot-cloudinit] done at $(date -Is)" >> "$LOG"
`;
}

// ============================================================================
// Utility internal
// ============================================================================
function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _sanitizeHostname(name) {
  // Hostname RFC-compliant: alphanumeric + dash, max 63 char, no leading/trailing dash
  return (
    String(name || 'srv')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63) || 'srv'
  );
}

function _extractError(err) {
  const data = err && err.response && err.response.data;
  if (typeof data === 'string') return data;
  const errObj = data && data.error;
  if (errObj) {
    return `${errObj.error_code || 'ERROR'}: ${
      errObj.error_message || JSON.stringify(errObj).slice(0, 200)
    }`;
  }
  return (err && err.message) || 'unknown error';
}

function _slugify(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ============================================================================
// Auth probe
// ============================================================================
async function upcloudProbeAuth(token) {
  try {
    const res = await axios.get(`${UPCLOUD_API}/account`, {
      headers: upcloudHeaders(token),
      timeout: 30000,
    });
    const acc = res.data && res.data.account;
    return {
      ok: true,
      email: (acc && (acc.username || acc.account)) || 'upcloud-account',
      credits: acc && acc.credits,
    };
  } catch (err) {
    return { ok: false, error: _extractError(err) };
  }
}

// Info akun UpCloud untuk panel admin "Cek Status Akun".
// Endpoint UpCloud beda dari DigitalOcean (yang dipakai default di doApi),
// makanya kalau tidak di-route ke sini akan HTTP 401 (INVALID palsu).
// GET /1.3/account -> { account: { username, credits, ... } }
async function upcloudAccountInfo(token) {
  try {
    const res = await axios.get(`${UPCLOUD_API}/account`, {
      headers: upcloudHeaders(token),
      timeout: 30000,
    });
    const acc = (res.data && res.data.account) || {};
    return {
      ok: true,
      account: {
        email: acc.username || acc.account || 'upcloud-account',
        uuid: acc.account || acc.username || '-',
        status: 'active',
        email_verified: null,
        credits: acc.credits,
        droplet_limit: '-',
        floating_ip_limit: '-',
      },
      error: null,
      statusCode: res.status,
    };
  } catch (err) {
    const status = err && err.response && err.response.status;
    return { ok: false, account: null, error: _extractError(err), statusCode: status || null };
  }
}

// Hitung jumlah server aktif di akun UpCloud. GET /1.3/server -> { servers: { server: [...] } }
async function upcloudServersCount(token) {
  try {
    const res = await axios.get(`${UPCLOUD_API}/server`, {
      headers: upcloudHeaders(token),
      timeout: 30000,
    });
    const list = (res.data && res.data.servers && res.data.servers.server) || [];
    return { ok: true, count: Array.isArray(list) ? list.length : 0, error: null };
  } catch (err) {
    return { ok: false, count: null, error: _extractError(err) };
  }
}

// ============================================================================
// Zones
// ============================================================================
async function upcloudGetZones(token) {
  const res = await axios.get(`${UPCLOUD_API}/zone`, {
    headers: upcloudHeaders(token),
    timeout: 30000,
  });
  const zones = (res.data && res.data.zones && res.data.zones.zone) || [];
  // Filter zone "public": "no" (private cloud zones) supaya user tidak salah pilih
  return zones
    .filter((z) => String(z.public || 'yes').toLowerCase() !== 'no')
    .map((z) => ({
      slug: z.id,
      id: z.id,
      name: z.description || z.id,
      available: true,
      provider: 'upcloud',
    }));
}

// ============================================================================
// Plans + custom sizes (unified list)
// ============================================================================
/**
 * Ambil plans yang akan ditampilkan ke user.
 *
 * FILTER: HANYA Cloud Native (bring-your-own-storage). Alasan:
 *   1. Cloud Native = plan tanpa built-in disk → kita provide disk sendiri
 *      via storage_devices dengan `pickDiskGb(ramMb)`. Sesuai design kita.
 *   2. Starter/Premium plans include built-in disk kecil (25GB/50GB) yang
 *      TIDAK compatible dengan flow kita — pasti conflict ukuran.
 *   3. Total plan berkurang drastis → UI pagination lebih ringan & cepat.
 *
 * Detect Cloud Native via 3 heuristic (any match = accept):
 *   a. Plan name mengandung "CLOUDNATIVE" atau "cloud-native" (case-insensitive)
 *   b. `storage_size === 0` (tidak ada built-in disk = kita provide sendiri)
 *   c. `storage_tier === "maxiops"` DAN `storage_size === 0` (double-check)
 */
function _isCloudNativePlan(p) {
  // Exclude GPU plans — docs example shows they have storage_size=0 & gpu_amount>0,
  // sehingga lolos filter "bring-your-own-storage" tapi bukan Cloud Native.
  if (Number(p.gpu_amount || 0) > 0) return false;
  // Exclude plans dengan storage_tier=null (biasanya = GPU tanpa storage sama sekali)
  if (p.storage_tier === null && Number(p.storage_size || 0) === 0) {
    // Kalau bukan GPU tapi storage_tier null, kemungkinan bukan Cloud Native standar
    // Only accept kalau name mengandung "cloudnative" explicit
    const nm = String(p.name || '').toLowerCase();
    if (!/cloud[\s_-]*native/.test(nm)) return false;
  }
  const name = String(p.name || '').toLowerCase();
  if (/cloud[\s_-]*native/.test(name)) return true;
  const storageSize = Number(p.storage_size || 0);
  if (storageSize === 0) return true;
  return false;
}

// ============================================================================
// Plan name cache
// ============================================================================
// UpCloud "custom plans" restricted (contact sales). Untuk avoid errors, kita
// SELALU gunakan plan name asli (mis. "CLOUDNATIVE-4xCPU-8GB") saat create.
// Callback ke Telegram tetap pakai short slug (mis. "up-4c-8g"), lalu
// resolve balik ke full name via cache saat create.
const _planNameCache = new Map(); // shortSlug -> fullPlanName

function _resolvePlanName(shortSlug) {
  return _planNameCache.get(String(shortSlug)) || null;
}

// Common RAM sizes yang biasa dipakai untuk RDP/VPS. Kalau UpCloud return
// plans dengan RAM aneh-aneh (mis. 3GB, 10GB, 20GB), skip biar UI tidak
// overload. Kalau user butuh, bisa ditambah ke list ini.
const _COMMON_RAM_GB = new Set([1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128]);

async function upcloudGetPlans(token) {
  let plans = [];
  try {
    const planRes = await axios.get(`${UPCLOUD_API}/plan`, {
      headers: upcloudHeaders(token),
      timeout: 30000,
    });
    plans = (planRes.data && planRes.data.plans && planRes.data.plans.plan) || [];
  } catch (err) {
    console.warn('[upcloud] getPlans warning (using empty list):', _extractError(err));
  }

  // Debug: log struktur plan pertama (biar ketahuan schema-nya kalau perlu tune filter)
  if (plans.length > 0) {
    console.log('[upcloud] sample plan[0]:', JSON.stringify(plans[0]).slice(0, 300));
  }

  // Filter berlapis untuk mendapatkan Cloud Native subset yang manageable:
  //   1. Match Cloud Native (nama contains "cloudnative" ATAU storage_size = 0)
  //   2. RAM adalah common size (bukan 3GB, 10GB, 20GB, dst)
  //   3. Dedup by (cores, memory) — kalau ada duplicate combo, ambil satu
  const filtered = plans.filter(_isCloudNativePlan);
  const commonRam = filtered.filter((p) => {
    const ramGb = Math.round(Number(p.memory_amount || 0) / 1024);
    return _COMMON_RAM_GB.has(ramGb);
  });

  const dedupMap = new Map();
  for (const p of commonRam) {
    const cores = Number(p.core_number || 0);
    const memMb = Number(p.memory_amount || 0);
    const key = `${cores}c-${memMb}mb`;
    if (!dedupMap.has(key)) dedupMap.set(key, p);
  }
  const deduped = Array.from(dedupMap.values());

  // Hard cap: 40 plans supaya UI pagination max ~3 halaman
  const capped = deduped.slice(0, 40);

  console.log(
    `[upcloud] plans total=${plans.length} cloud_native=${filtered.length} common_ram=${commonRam.length} deduped=${deduped.length} shown=${capped.length}`,
  );

  const normalized = capped.map((p) => {
    const cores = Number(p.core_number || 0);
    const memMb = Number(p.memory_amount || 0);
    const shortSlug = _encodeShortSlug(cores, memMb);
    const provisionedDisk = pickDiskGb(memMb);

    // Populate cache: shortSlug -> full plan name. Dipakai di
    // upcloudCreateServer supaya bisa create pakai plan name asli
    // (bukan `plan: custom` yang mungkin restricted di new accounts).
    _planNameCache.set(shortSlug, p.name);

    return {
      slug: shortSlug,       // <-- PENDEK, buat callback Telegram (max 9 chars)
      id: shortSlug,
      memory: memMb,
      vcpus: cores,
      disk: provisionedDisk,
      transfer: Number(p.public_traffic_out || 0),
      price_monthly: 0,
      available: true,
      regions: [],
      label: p.name,          // <-- Nama asli buat display di button
      provider: 'upcloud',
      isCustom: false,
    };
  });

  return normalized.sort(
    (a, b) => a.vcpus - b.vcpus || a.memory - b.memory || a.slug.localeCompare(b.slug),
  );
}

// ============================================================================
// Public OS templates (Ubuntu / dsb)
// ============================================================================
let _templateCache = null;
let _templateCacheAt = 0;
const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit

async function _fetchAllTemplates(token) {
  const now = Date.now();
  if (_templateCache && now - _templateCacheAt < TEMPLATE_CACHE_TTL_MS) return _templateCache;

  const res = await axios.get(`${UPCLOUD_API}/storage/template`, {
    headers: upcloudHeaders(token),
    timeout: 30000,
  });
  const storages = (res.data && res.data.storages && res.data.storages.storage) || [];
  const templates = storages
    .filter((s) => String(s.access || '').toLowerCase() === 'public')
    .map((s) => ({
      uuid: s.uuid,
      title: s.title || '',
      size: Number(s.size || 0),
    }));

  _templateCache = templates;
  _templateCacheAt = now;
  return templates;
}

/**
 * Return list of Ubuntu 22.04 image dengan slug PENDEK supaya callback Telegram
 * tidak overflow 64 byte.
 *
 * Contoh: slug lama = "upcloud/ubuntu-server-22.04-lts-jammy-jellyfish" (46 char)
 *         slug baru = "upcloud/ubuntu22" (16 char)
 *
 * Kita cuma expose 1 image (Ubuntu 22.04 LTS, konfirmasi dari doc official)
 * karena bot flow-nya reformat ke Windows lewat tele.sh anyway — user tidak
 * perlu banyak pilihan OS.
 */
async function upcloudGetImages(_token) {
  // Slug PENDEK supaya callback Telegram tidak overflow 64 byte.
  // Template UUID di-resolve dinamis saat create via upcloudResolveTemplateUuid()
  // (match judul template), jadi tidak perlu hardcode UUID tiap OS.
  return [
    { label: '🟠 Ubuntu Server 24.04 LTS', slug: 'upcloud/ubuntu24' },
    { label: '🟠 Ubuntu Server 22.04 LTS', slug: 'upcloud/ubuntu22' },
    { label: '🟠 Ubuntu Server 20.04 LTS', slug: 'upcloud/ubuntu20' },
    { label: '🔵 Debian 12 (Bookworm)', slug: 'upcloud/debian12' },
    { label: '🔵 Debian 11 (Bullseye)', slug: 'upcloud/debian11' },
  ];
}

// Peta slug -> matcher judul template UpCloud (untuk resolve UUID dinamis).
const _UPCLOUD_OS_MATCHERS = [
  { slug: 'ubuntu24', re: /ubuntu.*24\.04/i },
  { slug: 'ubuntu22', re: /ubuntu.*22\.04/i },
  { slug: 'ubuntu20', re: /ubuntu.*20\.04/i },
  { slug: 'debian12', re: /debian[^0-9]*12(\D|$)/i },
  { slug: 'debian11', re: /debian[^0-9]*11(\D|$)/i },
];

/**
 * Resolve template UUID dari image slug user (mis. "upcloud/ubuntu24",
 * "upcloud/debian12", atau "upcloud/ubuntu22.04").
 *
 * Strategi:
 *   1. Ubuntu 22.04 -> fast path konstan UBUNTU_22_04_UUID (skip API).
 *   2. Lainnya -> fetch /storage/template (cached 10 menit), match judul.
 *   3. Fallback -> Ubuntu 22.04.
 */
async function upcloudResolveTemplateUuid(token, imageSlug) {
  const slug = String(imageSlug || '').toLowerCase();

  // Fast path Ubuntu 22.04 (paling sering + UUID sudah dikonfirmasi doc).
  if ((slug.includes('ubuntu22') || slug.includes('22.04') || !slug) && UBUNTU_22_04_UUID) {
    return UBUNTU_22_04_UUID;
  }

  // Cari matcher yang cocok dengan slug.
  let matcher = _UPCLOUD_OS_MATCHERS.find((m) => slug.includes(m.slug));
  // Kalau slug pakai format titik (ubuntu-24.04) tebak dari angka.
  if (!matcher) {
    if (/debian.*12/.test(slug)) matcher = _UPCLOUD_OS_MATCHERS.find((m) => m.slug === 'debian12');
    else if (/debian.*11/.test(slug)) matcher = _UPCLOUD_OS_MATCHERS.find((m) => m.slug === 'debian11');
    else if (/24\.?04|ubuntu24/.test(slug)) matcher = _UPCLOUD_OS_MATCHERS.find((m) => m.slug === 'ubuntu24');
    else if (/20\.?04|ubuntu20/.test(slug)) matcher = _UPCLOUD_OS_MATCHERS.find((m) => m.slug === 'ubuntu20');
  }

  if (matcher) {
    try {
      const templates = await _fetchAllTemplates(token);
      const found = templates.find((t) => matcher.re.test(t.title));
      if (found && found.uuid) return found.uuid;
      console.warn(`[upcloud] template utk slug "${slug}" tidak ketemu, fallback Ubuntu 22.04.`);
    } catch (err) {
      console.warn(`[upcloud] resolve template error utk "${slug}":`, _extractError(err));
    }
  }

  // Fallback Ubuntu 22.04.
  if (UBUNTU_22_04_UUID) return UBUNTU_22_04_UUID;
  return await findUbuntu2204TemplateUuid(token);
}

/**
 * Return UUID template Ubuntu 22.04.
 *
 * Fast path: pakai konstan UBUNTU_22_04_UUID (dikonfirmasi dari doc official
 * section 9. Storages). Skip API call, langsung return. Kalau suatu hari
 * UUID ini berubah, fallback ke discovery via GET /storage/template.
 */
async function findUbuntu2204TemplateUuid(token) {
  // Fast path: hardcoded UUID dari official doc
  if (UBUNTU_22_04_UUID) return UBUNTU_22_04_UUID;

  // Fallback path (kalau hardcoded suatu hari null'd): dynamic discovery
  const templates = await _fetchAllTemplates(token);
  const cascade = [
    (t) => /ubuntu\s*(server\s*)?22\.04/i.test(t.title),
    (t) => /ubuntu.*24\.04/i.test(t.title),
    (t) => /ubuntu.*20\.04/i.test(t.title),
    (t) => /ubuntu/i.test(t.title),
  ];
  for (const test of cascade) {
    const m = templates.find(test);
    if (m) return m.uuid;
  }
  throw new Error(
    'Ubuntu template tidak ditemukan di UpCloud public templates. Cek /storage/template.',
  );
}

// ============================================================================
// Slug encoding untuk callback Telegram
// ============================================================================
// Telegram callback_data max 64 bytes. Nama plan UpCloud (mis.
// "CLOUDNATIVE-8xCPU-32GB", 22 chars) bikin callback overflow saat digabung
// dengan prefix + apiId + region.
//
// Solusi: encode slug jadi format pendek deterministik `<cores>c<memGb>g`.
//   - "CLOUDNATIVE-4xCPU-8GB"  -> "up-4c-8g"   (8 chars)
//   - "CLOUDNATIVE-8xCPU-32GB" -> "up-8c-32g"  (9 chars)
// Deterministik = bisa decode balik tanpa perlu cache.
// Prefix "up-" supaya bisa dibedakan dari slug DO/Linode/AWS.
function _encodeShortSlug(cores, memoryMb) {
  const memGb = Math.round(Number(memoryMb || 0) / 1024);
  return `up-${cores}c-${memGb}g`;
}

function _decodeShortSlug(slug) {
  const m = String(slug || '').match(/^up-(\d+)c-(\d+)g$/i);
  if (!m) return null;
  return { cores: Number(m[1]), memoryMb: Number(m[2]) * 1024 };
}

/**
 * Ambil RAM (MB) dari slug UpCloud. Prioritas:
 *   1. Short slug "up-4c-8g" (baru, dipakai di callback)
 *   2. Original plan name "CLOUDNATIVE-4xCPU-8GB" atau "1xCPU-2GB" (backward-compat)
 *   3. "<n>GB" anywhere (fallback general)
 */
function _extractRamMbFromSlug(slug) {
  const short = _decodeShortSlug(slug);
  if (short) return short.memoryMb;
  const s = String(slug || '');
  const m1 = s.match(/(\d+)\s*x?\s*CPU[-_ ]+(\d+)\s*GB/i);
  if (m1) return Number(m1[2]) * 1024;
  const m2 = s.match(/(\d+)\s*GB(?!\S)/i);
  if (m2) return Number(m2[1]) * 1024;
  return 2048;
}

// ============================================================================
// Firewall management
// ============================================================================
// PENTING (temuan field test): UpCloud L3 firewall yang ENABLED (forced di trial
// account) TIDAK otomatis accept-all. Port non-standard seperti 4443 (RDP yang
// dipakai bot) ke-DROP, sementara port umum (22/80/443) lolos. Gejalanya:
//   - Bot SSH ke Ubuntu (port 22) BERHASIL -> tele.sh jalan sampai selesai
//   - Setelah DD ke Windows, port 4443 timeout SELAMANYA
//
// Karena itu kita harus EKSPLISIT add accept rules untuk port yang bot pakai.
//
// Trial account limitation: `TRIAL_FIREWALL` error muncul kalau kita coba
// disable firewall ATAU (kemungkinan) modify rules. Kita handle gracefully:
// kalau API nolak, kita simpan note supaya bot bisa kasih tau user untuk
// buka port manual via panel / SDN firewall.

// Port yang bot butuhkan terbuka:
//   22   -> SSH (bot jalanin installer)
//   3389 -> RDP default (kalau user pakai port standar)
//   4443 -> RDP port yang bot set di tele.sh (--rdp-port 4443)
//   80   -> HTTP (fastpanel/cloud9/certbot)
//   443  -> HTTPS
//   8006 -> web interface installer lama
//   8080 -> Cloud9 / dev server
const UPCLOUD_REQUIRED_PORTS = [22, 80, 443, 3389, 4443, 8006, 8080];

// Cache note firewall per server uuid supaya handler bisa surface warning
// ke user tanpa harus re-query API.
const _firewallNoteCache = new Map();

/**
 * Ambil note hasil pembukaan firewall untuk satu server.
 * @returns {{ok: boolean, trialBlocked: boolean, method: string, error: string|null}|null}
 */
function upcloudGetFirewallNote(uuid) {
  return _firewallNoteCache.get(String(uuid)) || null;
}

function _isTrialFirewallError(err) {
  const msg = String(_extractError(err) || '');
  return /TRIAL_FIREWALL/i.test(msg) || /trial mode firewall/i.test(msg);
}

/**
 * Accept-all inbound (IPv4 + IPv6). Rule tanpa `protocol` dan tanpa port
 * range = WILDCARD (semua protocol, semua port). Ini paling simple dan
 * ekuivalen dengan firewall off, tapi tetap kompatibel dengan trial yang
 * memaksa firewall on.
 */
async function _addAcceptAllRules(token, uuid) {
  const families = [
    { family: 'IPv4', position: '1' },
    { family: 'IPv6', position: '2' },
  ];
  for (const r of families) {
    await axios.post(
      `${UPCLOUD_API}/server/${encodeURIComponent(uuid)}/firewall_rule`,
      {
        firewall_rule: {
          action: 'accept',
          comment: 'bot: accept all inbound',
          direction: 'in',
          family: r.family,
          position: r.position,
        },
      },
      { headers: upcloudHeaders(token), timeout: 30000 },
    );
  }
}

/**
 * Fallback kalau accept-all ditolak: add rule per-port eksplisit (TCP+UDP)
 * untuk port yang bot butuhkan. Lebih besar kemungkinan lolos validasi
 * karena bukan wildcard.
 *
 * Return jumlah rule yang BERHASIL di-add.
 */
async function _addPerPortRules(token, uuid) {
  let added = 0;
  let position = 1;
  for (const port of UPCLOUD_REQUIRED_PORTS) {
    for (const protocol of ['tcp', 'udp']) {
      try {
        await axios.post(
          `${UPCLOUD_API}/server/${encodeURIComponent(uuid)}/firewall_rule`,
          {
            firewall_rule: {
              action: 'accept',
              comment: `bot: allow ${protocol}/${port}`,
              direction: 'in',
              family: 'IPv4',
              protocol,
              destination_port_start: String(port),
              destination_port_end: String(port),
              position: String(position),
            },
          },
          { headers: upcloudHeaders(token), timeout: 30000 },
        );
        added += 1;
        position += 1;
      } catch (err) {
        // Kalau trial block, semua rule berikutnya pasti gagal juga -> stop early.
        if (_isTrialFirewallError(err)) throw err;
        console.warn(
          `[upcloud] add rule ${protocol}/${port} for ${uuid} failed:`,
          _extractError(err),
        );
      }
    }
  }
  return added;
}

/**
 * Pastikan port yang bot butuhkan (terutama RDP 4443) terbuka di UpCloud
 * L3 firewall. Best-effort: kalau gagal, TIDAK throw — cuma simpan note.
 *
 * Strategi berjenjang:
 *   1. accept-all rules (paling simple, ekuivalen firewall off)
 *   2. per-port rules (fallback kalau wildcard ditolak)
 *   3. PUT firewall=off (fallback terakhir, cuma jalan di paid account)
 *
 * @returns {Promise<{ok: boolean, trialBlocked: boolean, method: string, error: string|null}>}
 */
async function upcloudEnsureFirewallOpen(token, uuid) {
  const key = String(uuid);

  // 1. accept-all
  try {
    await _addAcceptAllRules(token, uuid);
    const note = { ok: true, trialBlocked: false, method: 'accept-all', error: null };
    _firewallNoteCache.set(key, note);
    console.log(`[upcloud] firewall opened for ${uuid} via accept-all rules.`);
    return note;
  } catch (err) {
    const trialBlocked = _isTrialFirewallError(err);
    console.warn(
      `[upcloud] accept-all rules for ${uuid} failed${trialBlocked ? ' (TRIAL_FIREWALL)' : ''}:`,
      _extractError(err),
    );

    // 2. per-port fallback (skip kalau trial sudah jelas nolak rule mgmt)
    if (!trialBlocked) {
      try {
        const added = await _addPerPortRules(token, uuid);
        if (added > 0) {
          const note = {
            ok: true,
            trialBlocked: false,
            method: `per-port (${added} rules)`,
            error: null,
          };
          _firewallNoteCache.set(key, note);
          console.log(`[upcloud] firewall opened for ${uuid} via ${added} per-port rules.`);
          return note;
        }
      } catch (err2) {
        if (_isTrialFirewallError(err2)) {
          const note = {
            ok: false,
            trialBlocked: true,
            method: 'none',
            error: 'TRIAL_FIREWALL: trial account tidak bisa modify firewall rules',
          };
          _firewallNoteCache.set(key, note);
          console.warn(`[upcloud] firewall for ${uuid}: TRIAL_FIREWALL blocks rule management.`);
          return note;
        }
        console.warn(`[upcloud] per-port rules for ${uuid} failed:`, _extractError(err2));
      }

      // 3. firewall=off (paid account only)
      try {
        await axios.put(
          `${UPCLOUD_API}/server/${encodeURIComponent(uuid)}`,
          { server: { firewall: 'off' } },
          { headers: upcloudHeaders(token), timeout: 30000 },
        );
        const note = { ok: true, trialBlocked: false, method: 'firewall=off', error: null };
        _firewallNoteCache.set(key, note);
        console.log(`[upcloud] firewall disabled for ${uuid} (fallback path).`);
        return note;
      } catch (err3) {
        const note = {
          ok: false,
          trialBlocked: _isTrialFirewallError(err3),
          method: 'none',
          error: _extractError(err3),
        };
        _firewallNoteCache.set(key, note);
        console.warn(`[upcloud] all firewall strategies failed for ${uuid}:`, note.error);
        return note;
      }
    }

    const note = {
      ok: false,
      trialBlocked: true,
      method: 'none',
      error: 'TRIAL_FIREWALL: trial account tidak bisa modify firewall',
    };
    _firewallNoteCache.set(key, note);
    return note;
  }
}

/**
 * Pesan siap-pakai untuk user kalau firewall gagal dibuka otomatis.
 * Return null kalau tidak ada masalah.
 */
function upcloudFirewallWarningText(uuid, rdpPort = 4443) {
  const note = upcloudGetFirewallNote(uuid);
  if (!note || note.ok) return null;
  if (note.trialBlocked) {
    return (
      `⚠️ *Firewall UpCloud belum bisa dibuka otomatis*\n` +
      `Akun trial UpCloud tidak mengizinkan bot mengubah firewall rules.\n\n` +
      `Port RDP \`${rdpPort}\` kemungkinan masih DROP, jadi RDP tidak akan bisa connect ` +
      `walaupun instalasi Windows berhasil.\n\n` +
      `*Solusi (pilih salah satu):*\n` +
      `1️⃣ Buka [hub.upcloud.com](https://hub.upcloud.com) → pilih server → tab *Firewall* → ` +
      `tambah rule: direction *in*, action *accept*, protocol *TCP*, port *${rdpPort}*\n` +
      `2️⃣ Atau buat *SDN Firewall* sendiri lalu attach ke server\n` +
      `3️⃣ Atau upgrade akun UpCloud dari trial (bot bisa auto-manage firewall)`
    );
  }
  return (
    `⚠️ *Firewall UpCloud gagal dibuka otomatis*\n` +
    `Detail: \`${note.error || 'unknown'}\`\n\n` +
    `Silakan buka port \`${rdpPort}\` manual di hub.upcloud.com → server → tab Firewall.`
  );
}

// ============================================================================
// Create server
// ============================================================================
/**
 * @param {string} token
 * @param {string} name       server title (akan di-sanitize jadi hostname)
 * @param {string} zone       zone id, mis. "fi-hel1", "us-chi1"
 * @param {string} sizeSlug   plan slug ("1xCPU-2GB") atau custom ("custom-2c-4096mb")
 * @param {string} _imageSlug (IGNORED — kita selalu clone dari Ubuntu 22.04 template)
 * @param {string} userData   cloud-init YAML (akan di-base64 saat kirim)
 * @returns {Promise<{dropletId: string|null, sshPrivateKey: string|null, sshUsername: string|null, error: string|null, provider: string}>}
 */
async function upcloudCreateServer(token, name, zone, sizeSlug, _imageSlug, userData) {
  let templateUuid;
  try {
    // Resolve template dari image slug yang dipilih user (Ubuntu 24/22/20,
    // Debian 12/11). RDP flow kirim ubuntu22.04 (OS Linux di-reformat ke
    // Windows anyway, jadi versi bebas).
    templateUuid = await upcloudResolveTemplateUuid(token, _imageSlug);
  } catch (err) {
    return {
      dropletId: null,
      sshPrivateKey: null,
      sshUsername: null,
      error: `UpCloud: ${err.message}`,
      provider: 'upcloud',
    };
  }

  const hostname = _sanitizeHostname(name || `srv-${Date.now()}`);

  // Generate ephemeral SSH keypair. Public key masuk ke login_user.ssh_keys
  // supaya UpCloud inject ke /root/.ssh/authorized_keys (docs: cloud-init
  // template SATU-satunya cara SSH masuk = ssh_keys). Private key kita
  // return balik ke bot supaya installer bisa SSH pakai key ini.
  let sshKeys;
  try {
    sshKeys = _generateSshKeyPair();
  } catch (err) {
    return {
      dropletId: null,
      sshPrivateKey: null,
      sshUsername: null,
      error: `UpCloud SSH keypair gen failed: ${err.message}`,
      provider: 'upcloud',
    };
  }

  // Cloud-init tambahan sebagai belt-and-suspenders:
  //   1. Set root password (fallback kalau tele.sh butuh)
  //   2. Enable PermitRootLogin + PasswordAuthentication
  //   3. Disable ufw supaya SSH tidak diblok OS-level
  // NOTE: ssh_authorized_keys sudah di-inject via login_user.ssh_keys — user_data
  // ini tidak perlu inject key lagi.
  const rootPassword = _parseRootPassword(userData);
  const cloudInit = _buildUpcloudCloudInit(rootPassword);
  const userDataB64 = Buffer.from(cloudInit, 'utf8').toString('base64');

  // Resolve slug ke plan name:
  //   1. Short slug (`up-4c-8g`): resolve dari _planNameCache ke plan name asli.
  //      Kalau cache miss (bot restart / cache expired), refetch plans.
  //   2. Legacy full plan name: langsung pakai as-is.
  //
  // WHY: UpCloud custom plans restricted (doc section 7: "Custom plans are
  // available for new customers through contact with sales"). Jadi kita
  // selalu pakai plan name asli (Simple Plans), bukan `plan: 'custom'`.
  const shortDecoded = _decodeShortSlug(sizeSlug);
  const ramMb = shortDecoded ? shortDecoded.memoryMb : _extractRamMbFromSlug(sizeSlug);
  const diskGb = pickDiskGb(ramMb);

  let planName = null;
  if (shortDecoded) {
    planName = _resolvePlanName(sizeSlug);
    if (!planName) {
      // Cache miss (bot mungkin restart) → refetch plans utk repopulate cache
      console.log(`[upcloud] cache miss for ${sizeSlug}, refetching plans...`);
      try {
        await upcloudGetPlans(token);
        planName = _resolvePlanName(sizeSlug);
      } catch (e) {
        console.warn('[upcloud] refetch plans failed:', _extractError(e));
      }
    }
    if (!planName) {
      // Terakhir resort: coba `plan: 'custom'`. Mungkin gagal di new accounts.
      console.warn(
        `[upcloud] cannot resolve plan name for ${sizeSlug}, falling back to 'custom' (may fail on new accounts)`,
      );
    }
  } else {
    // Legacy path: sizeSlug bukan short encoded, langsung pakai as-is.
    planName = String(sizeSlug);
  }

  const planField = planName
    ? { plan: planName }
    : {
        plan: 'custom',
        core_number: String(shortDecoded.cores),
        memory_amount: String(shortDecoded.memoryMb),
      };

  const body = {
    server: {
      title: String(name || hostname).slice(0, 64),
      hostname,
      zone: String(zone),
      // Field `firewall` sengaja DIHILANGKAN (bukan "on" atau "off") supaya
      // UpCloud pakai default per account tier:
      //   - Trial account: FORCED firewall=on (trial policy, tidak bisa
      //     disable — sebelumnya kita kirim "off" -> TRIAL_FIREWALL error).
      //     Default rule = ACCEPT-ALL (per UpCloud managing-firewall guide:
      //     user harus manual set ke "Drop" supaya blokir), jadi server
      //     tetap reachable di port 22/RDP/dst.
      //   - Paid account: default firewall=disabled -> no filtering.
      // Keduanya server tetap SSH-able tanpa kita perlu manage rules.
      // OS-level firewall (ufw/iptables) tetap di-disable via cloud-init
      // runcmd sebagai belt-and-suspenders.
      timezone: 'UTC',
      // WAJIB "yes" kalau template pakai cloud-init (Ubuntu 22.04, dst).
      // Tanpa ini: UpCloud reject dengan METADATA_DISABLED_ON_CLOUD-INIT.
      metadata: 'yes',
      password_delivery: 'none', // no plaintext password delivery via email
      user_data: userDataB64,
      // login_user.ssh_keys = cara resmi UpCloud untuk cloud-init templates
      // (docs: "ssh_keys are also the only login method for cloud-init
      // enabled templates"). Bot pakai private key untuk SSH masuk.
      // username=root supaya key di-inject langsung ke /root/.ssh/authorized_keys.
      login_user: {
        username: 'root',
        create_password: 'no',
        ssh_keys: {
          ssh_key: [sshKeys.publicKeySsh],
        },
      },
      ...planField,
      storage_devices: {
        storage_device: [
          {
            action: 'clone',
            storage: templateUuid,
            title: `${hostname}-osdisk`,
            size: String(diskGb),
            tier: 'maxiops', // SSD NVMe
            // ADAPTER DISK — penting untuk DD Windows (tele.sh convert ke
            // Windows via bin456789/reinstall dd image). DD image guajibao
            // (win10ent.gz dll) di-build untuk kompatibilitas IDE. Kalau disk
            // di-attach sebagai VirtIO tapi image tidak punya driver viostor,
            // Windows BSOD INACCESSIBLE_BOOT_DEVICE saat first boot -> port
            // RDP (4443) timeout selamanya walau tele.sh "completed".
            //
            // Default kita paksa IDE (paling universal, pasti boot untuk DD
            // Windows image apapun). Bisa di-override via env:
            //   UPCLOUD_DISK_ADAPTER=virtio  (tercepat, butuh driver di image)
            //   UPCLOUD_DISK_ADAPTER=scsi
            //   UPCLOUD_DISK_ADAPTER=ide     (default, universal)
            address: _diskAddress(),
          },
        ],
      },
    },
  };

  let uuid;
  try {
    const res = await axios.post(`${UPCLOUD_API}/server`, body, {
      headers: upcloudHeaders(token),
      timeout: 90000,
    });
    uuid = res.data && res.data.server && res.data.server.uuid;
    if (!uuid) {
      return {
        dropletId: null,
        sshPrivateKey: null,
        sshUsername: null,
        error: 'UpCloud create server: response tidak berisi uuid.',
        provider: 'upcloud',
      };
    }
  } catch (err) {
    return {
      dropletId: null,
      sshPrivateKey: null,
      sshUsername: null,
      error: `UpCloud create server error: ${_extractError(err)}`,
      provider: 'upcloud',
    };
  }

  // Firewall management di-skip karena:
  //   - Server dibuat dengan `firewall: "off"` (semua traffic lolos di network level)
  //   - Trial accounts (`TRIAL_FIREWALL`) tetap kompatibel
  //   - Menghindari race dengan state `maintenance` server yang baru boot

  return {
    dropletId: uuid,
    sshPrivateKey: sshKeys.privateKeyPem,
    sshUsername: 'root',
    error: null,
    provider: 'upcloud',
  };
}

// ============================================================================
// Get server + wait for public IP
// ============================================================================
async function upcloudGetServer(token, uuid) {
  const res = await axios.get(`${UPCLOUD_API}/server/${encodeURIComponent(uuid)}`, {
    headers: upcloudHeaders(token),
    timeout: 30000,
  });
  return (res.data && res.data.server) || null;
}

function _extractPublicIpV4(server) {
  const ips = (server && server.ip_addresses && server.ip_addresses.ip_address) || [];
  const pub = ips.find(
    (x) =>
      String(x.access || '').toLowerCase() === 'public' &&
      String(x.family || '').toLowerCase() === 'ipv4',
  );
  return (pub && pub.address) || null;
}

async function upcloudWaitPublicIp(token, uuid, attempts = 30, delayMs = 10000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const server = await upcloudGetServer(token, uuid);
      if (server) {
        const state = String(server.state || '').toLowerCase();
        const ip = _extractPublicIpV4(server);
        // "started" = fully booted. "maintenance" = still provisioning.
        if (ip && (state === 'started' || state === 'running')) {
          // Firewall TIDAK di-utak-atik lagi: RDP UpCloud sekarang pakai port
          // 3389 yang SUDAH di-accept di firewall default UpCloud (48 rule
          // bawaan). SSH (22) juga default-accept. Jadi tidak perlu add rule
          // (yang lagipula gagal di trial -> TRIAL_FIREWALL). Fungsi
          // upcloudEnsureFirewallOpen tetap ada sebagai opt-in kalau nanti
          // butuh port custom di akun paid.
          return ip;
        }
      }
    } catch (err) {
      console.warn(`[upcloud] waitPublicIp attempt ${i + 1}/${attempts} error:`, _extractError(err));
    }
    await _sleep(delayMs);
  }
  return null;
}

// ============================================================================
// Power actions
// ============================================================================
async function upcloudPower(token, uuid, action) {
  const act = String(action || '').toLowerCase();
  if (act === 'start' || act === 'boot' || act === 'on' || act === 'power_on') {
    await axios.post(
      `${UPCLOUD_API}/server/${encodeURIComponent(uuid)}/start`,
      {},
      { headers: upcloudHeaders(token), timeout: 30000 },
    );
    return true;
  }
  if (act === 'stop' || act === 'off' || act === 'shutdown' || act === 'power_off') {
    await axios.post(
      `${UPCLOUD_API}/server/${encodeURIComponent(uuid)}/stop`,
      { stop_server: { stop_type: 'soft', timeout: '60' } },
      { headers: upcloudHeaders(token), timeout: 30000 },
    );
    return true;
  }
  if (act === 'restart' || act === 'reboot') {
    await axios.post(
      `${UPCLOUD_API}/server/${encodeURIComponent(uuid)}/restart`,
      { restart_server: { stop_type: 'soft', timeout: '60', timeout_action: 'ignore' } },
      { headers: upcloudHeaders(token), timeout: 30000 },
    );
    return true;
  }
  return false;
}

// ============================================================================
// Delete server
// ============================================================================
/**
 * UpCloud tidak mengizinkan DELETE server yang state=started. Kita stop dulu
 * (hard stop untuk cepat), tunggu sampai stopped, baru DELETE dengan
 * ?storages=1&backups=delete supaya disk & backup ikut dibersihkan.
 */
async function upcloudDeleteServer(token, uuid) {
  // 1. Stop kalau sedang running
  try {
    const server = await upcloudGetServer(token, uuid);
    const state = String((server && server.state) || '').toLowerCase();
    if (state === 'started' || state === 'running' || state === 'maintenance') {
      try {
        await axios.post(
          `${UPCLOUD_API}/server/${encodeURIComponent(uuid)}/stop`,
          { stop_server: { stop_type: 'hard', timeout: '10' } },
          { headers: upcloudHeaders(token), timeout: 30000 },
        );
      } catch (_) { /* ignore */ }

      // Wait until stopped (max ~60 detik)
      for (let i = 0; i < 20; i++) {
        await _sleep(3000);
        const s2 = await upcloudGetServer(token, uuid).catch(() => null);
        const s2state = String((s2 && s2.state) || '').toLowerCase();
        if (!s2 || s2state === 'stopped') break;
      }
    }
  } catch (_) { /* ignore, delete tetap dicoba */ }

  // 2. Delete server + storage + backup
  try {
    await axios.delete(
      `${UPCLOUD_API}/server/${encodeURIComponent(uuid)}?storages=1&backups=delete`,
      {
        headers: upcloudHeaders(token),
        timeout: 60000,
      },
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: _extractError(err) };
  }
}

// ============================================================================
// SSH readiness probe
// ============================================================================
/**
 * Actively test that password auth works over SSH ke root@ip. Return true
 * kalau BERHASIL, false kalau timeout. Guna: sesudah UpCloud VPS dibuat +
 * dapat IP, cloud-init masih running (write drop-in sshd_config + sed edit
 * + restart sshd). Kalau bot langsung kasih tau user password, user coba
 * SSH duluan, sshd belum di-restart -> tetap ditolak.
 *
 * Bot pakai probe ini untuk poll sampai sshd sudah re-read config yang
 * enable PasswordAuthentication yes. Baru kirim message "VPS BERHASIL
 * DIBUAT" ke user, sehingga user segera bisa konek.
 *
 * @param {string} ip     Public IP VPS
 * @param {string} password  Root password bot generated
 * @param {object} opts   { maxWaitMs, retryEveryMs, onLog }
 * @returns {Promise<boolean>}
 */
async function upcloudWaitSshPasswordReady(ip, password, opts = {}) {
  const maxWaitMs = opts.maxWaitMs || 6 * 60 * 1000; // 6 menit
  const retryEveryMs = opts.retryEveryMs || 12 * 1000; // 12 detik
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const result = await _sshAuthProbe(ip, password);
    if (result.ok) {
      onLog(`[upcloud-ssh-probe] auth OK di attempt ${attempt} (${Math.round((Date.now() - (deadline - maxWaitMs)) / 1000)}s)`);
      return true;
    }
    // Auth failure vs network transient: keduanya retryable di window awal.
    // Kita log tapi tetap coba lagi sampai deadline.
    onLog(`[upcloud-ssh-probe] attempt ${attempt} FAIL: ${result.reason}`);
    if (Date.now() + retryEveryMs > deadline) break;
    await _sleep(retryEveryMs);
  }
  onLog(`[upcloud-ssh-probe] TIMEOUT after ${Math.round(maxWaitMs / 1000)}s (${attempt} attempts)`);
  return false;
}

/**
 * PROVISION ROOT ACCESS VIA SSH KEY (pola ala AWS).
 *
 * Kenapa perlu ini: UpCloud Ubuntu 22.04 = cloud-init template. Begitu kita
 * inject `login_user.ssh_keys`, UpCloud OTOMATIS set `PasswordAuthentication
 * no` di sshd (docs: cloud-init template = key-only login). cloud-init
 * user_data kita yang coba re-enable password auth sering KALAH timing /
 * ordering dengan config UpCloud -> password auth gagal SELAMANYA.
 *
 * Solusi (sama seperti AWS yang connect via key lalu sudo): bot SSH masuk
 * pakai PRIVATE KEY ephemeral (yang PASTI diterima karena kita yang inject
 * public key-nya), lalu AKTIF jalankan perintah:
 *   - set root password (echo root:PASS | chpasswd)
 *   - PermitRootLogin yes + PasswordAuthentication yes di main sshd_config
 *   - nuke SEMUA drop-in /etc/ssh/sshd_config.d/*.conf yang matiin password
 *   - restart sshd
 * Setelah ini, user bisa login pakai password root yang bot kasih.
 *
 * Return true kalau perintah berhasil dijalankan, false kalau timeout.
 *
 * @param {string} ip
 * @param {string} privateKey  PEM private key (dari upcloudCreateServer)
 * @param {string} password    root password yang mau di-set
 * @param {object} opts { maxWaitMs, retryEveryMs, onLog }
 * @returns {Promise<boolean>}
 */
async function upcloudProvisionRootPassword(ip, privateKey, password, opts = {}) {
  const maxWaitMs = opts.maxWaitMs || 6 * 60 * 1000;
  const retryEveryMs = opts.retryEveryMs || 12 * 1000;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const deadline = Date.now() + maxWaitMs;

  if (!privateKey) {
    onLog('[upcloud-provision] no privateKey provided, skip');
    return false;
  }

  // POSIX single-quote escape untuk password.
  const passEsc = String(password || '').replace(/'/g, `'\\''`);
  const script = [
    `echo 'root:${passEsc}' | chpasswd`,
    `sed -i -E 's/^#?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config`,
    `grep -qE '^PermitRootLogin' /etc/ssh/sshd_config || echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config`,
    `sed -i -E 's/^#?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config`,
    `grep -qE '^PasswordAuthentication' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config`,
    `for f in /etc/ssh/sshd_config.d/*.conf; do [ -f "$f" ] || continue; sed -i -E 's/^[[:space:]]*#?[[:space:]]*PasswordAuthentication[[:space:]]+no/PasswordAuthentication yes/gI; s/^[[:space:]]*#?[[:space:]]*PermitRootLogin[[:space:]]+(no|prohibit-password)/PermitRootLogin yes/gI' "$f"; done`,
    `systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true`,
  ].join('; ');

  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const r = await _sshRunViaKey(ip, privateKey, script);
    if (r.ok) {
      onLog(`[upcloud-provision] root password set via SSH key di attempt ${attempt}`);
      return true;
    }
    onLog(`[upcloud-provision] attempt ${attempt} FAIL: ${r.reason}`);
    if (Date.now() + retryEveryMs > deadline) break;
    await _sleep(retryEveryMs);
  }
  onLog(`[upcloud-provision] TIMEOUT after ${attempt} attempts`);
  return false;
}

/**
 * SSH ke root@ip pakai private key, exec satu command, return hasil.
 * Timeout connect 8 detik supaya cepat retry.
 * @returns {Promise<{ok: boolean, reason: string, stdout: string, stderr: string}>}
 */
function _sshRunViaKey(ip, privateKey, command) {
  return new Promise((resolve) => {
    const conn = new SshClient();
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      resolve({ ok, reason, stdout, stderr });
    };

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) return finish(false, `exec-err: ${err.message}`);
        stream.on('close', (code) => {
          // code undefined/null = koneksi drop saat command jalan (mis. sshd
          // restart memutus sesi kita) -> anggap SUKSES karena command sudah
          // ke-submit dan restart memang efek yang kita mau.
          finish(code === 0 || code === undefined || code === null, `exit:${code}`);
        });
        stream.on('data', (d) => { stdout += d.toString(); });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });
      });
    });
    conn.on('error', (err) => {
      const msg = (err && err.message) || 'unknown';
      const level = (err && err.level) || '';
      finish(false, `${level || 'err'}: ${msg}`);
    });

    try {
      conn.connect({
        host: ip,
        port: 22,
        username: 'root',
        privateKey,
        readyTimeout: 8000,
        tryKeyboard: false,
      });
    } catch (err) {
      finish(false, `throw: ${err && err.message}`);
    }
  });
}

/**
 * Single-shot SSH auth probe. Timeout 8 detik supaya cepat retry.
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
function _sshAuthProbe(ip, password) {
  return new Promise((resolve) => {
    const conn = new SshClient();
    let settled = false;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      resolve({ ok, reason });
    };

    conn.on('ready', () => {
      finish(true, 'ready');
    });
    conn.on('error', (err) => {
      const msg = (err && err.message) || 'unknown';
      const level = (err && err.level) || '';
      // client-authentication = sshd nolak auth kita (masih pakai config lama).
      // client-socket / ECONNREFUSED / ETIMEDOUT = network belum ready.
      // Keduanya di-classify RETRYABLE oleh caller.
      finish(false, `${level || 'err'}: ${msg}`);
    });

    try {
      conn.connect({
        host: ip,
        port: 22,
        username: 'root',
        password,
        readyTimeout: 8000,
        tryKeyboard: false,
      });
    } catch (err) {
      finish(false, `throw: ${err && err.message}`);
    }
  });
}

// ============================================================================
// Exports
// ============================================================================
module.exports = {
  // Detection
  isUpCloudToken,
  // Utils
  pickDiskGb,
  // Metadata
  upcloudProbeAuth,
  upcloudAccountInfo,
  upcloudServersCount,
  upcloudGetZones,
  upcloudGetPlans,
  upcloudGetImages,
  findUbuntu2204TemplateUuid,
  upcloudResolveTemplateUuid,
  // Lifecycle
  upcloudCreateServer,
  upcloudGetServer,
  upcloudWaitPublicIp,
  upcloudPower,
  upcloudDeleteServer,
  // Post-create readiness
  upcloudWaitSshPasswordReady,
  upcloudProvisionRootPassword,
  // Firewall (opt-in, tidak auto-dipanggil — firewall dibiarkan default)
  upcloudEnsureFirewallOpen,
  upcloudGetFirewallNote,
  upcloudFirewallWarningText,
  UPCLOUD_REQUIRED_PORTS,
};
