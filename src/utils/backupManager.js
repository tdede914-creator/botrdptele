const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const db = require('../config/database');
const vpsManager = require('./vpsManager');

const BACKUP_ROOT = process.env.SERVER_BACKUP_DIR || path.join(__dirname, '../../backups');
const DEFAULT_TIMEOUT = Number(process.env.SERVER_BACKUP_TIMEOUT_MS || 20 * 60 * 1000);
const AUTO_CONCURRENCY = Number(process.env.SERVER_BACKUP_CONCURRENCY || 2);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function isRdpInstance(vps) {
  const type = String(vps?.product_type || '').toLowerCase();
  const image = String(vps?.image || '').toLowerCase();
  return type === 'rdp' || image.startsWith('rdp:');
}
function serverType(vps) { return isRdpInstance(vps) ? 'rdp' : 'vps'; }
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function backupDir(type, id) { return path.join(BACKUP_ROOT, type, String(id)); }
function latestPath(type, id) { return path.join(backupDir(type, id), 'latest.zip'); }

function backupKeyForSource(source, id) {
  // vps_instances: id positif
  // renter_instances: id negatif agar tidak bentrok dengan vps_instances
  if (source === 'renter') return -Math.abs(Number(id));
  return Math.abs(Number(id));
}

async function getManagedServer(instanceId) {
  const rawId = Number(instanceId);

  if (rawId < 0) {
    const rid = Math.abs(rawId);
    try {
      const row = await db.get(`
        SELECT id, user_id, api_id, droplet_id, ip, region, image, root_password, rdp_password,
               type as product_type, size_slug, status
        FROM renter_instances
        WHERE id = ? AND status = 1
      `, [rid]);
      if (!row) return null;
      row.__backup_source = 'renter';
      row.__backup_key = rawId;
      return row;
    } catch (_) {
      return null;
    }
  }

  const row = await vpsManager.getVpsInstance(rawId);
  if (!row) return null;
  row.__backup_source = 'order';
  row.__backup_key = rawId;
  return row;
}


async function ensureTables() {
  await db.run(`CREATE TABLE IF NOT EXISTS server_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id INTEGER NOT NULL UNIQUE,
    user_id INTEGER,
    type TEXT,
    ip TEXT,
    file_path TEXT,
    file_size INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER,
    last_error TEXT,
    updated_at INTEGER
  )`);
}

async function getBackupRecord(instanceId) {
  await ensureTables();
  return await db.get('SELECT * FROM server_backups WHERE instance_id = ?', [instanceId]);
}

async function isAutoBackupEnabled(instanceId) {
  const r = await getBackupRecord(instanceId);
  return !r || Number(r.enabled) !== 0;
}

async function setAutoBackup(instanceId, enabled) {
  await ensureTables();
  const vps = await getManagedServer(instanceId);
  await db.run(`INSERT INTO server_backups (instance_id, user_id, type, ip, enabled, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(instance_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`,
    [Number(instanceId), vps?.user_id || null, serverType(vps || {}), vps?.ip || null, enabled ? 1 : 0, nowSec()]);
}

function sshConnect({ host, username, password, port = 22, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timer = setTimeout(() => { try { conn.end(); } catch (_) {} reject(new Error('SSH timeout')); }, timeoutMs + 2000);
    conn.on('ready', () => { clearTimeout(timer); resolve(conn); });
    conn.on('error', (e) => { clearTimeout(timer); reject(e); });
    conn.connect({
      host,
      port,
      username,
      password,
      readyTimeout: timeoutMs,
      keepaliveInterval: 10000,
      // ssh2 tidak memunculkan pertanyaan "Are you sure you want to continue connecting?"
      // Opsi ini memastikan host key diterima otomatis untuk backup/restore server user.
      hostVerifier: () => true
    });
  });
}

function sshExec(conn, command, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('Command timeout: ' + command.slice(0, 120)));
    }, timeoutMs);
    conn.exec(command, { pty: true }, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      stream.on('data', d => stdout += d.toString());
      stream.stderr.on('data', d => stderr += d.toString());
      stream.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (code === 0 || code === undefined || code === null) resolve({ stdout, stderr, code });
        else reject(new Error(`Command failed (${code}): ${stderr || stdout}`));
      });
    });
  });
}

function sftpFastGet(conn, remotePaths, localPath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      let i = 0;
      const errors = [];
      const tryNext = () => {
        if (i >= remotePaths.length) {
          return reject(new Error('Backup file not found on remote server. Tried: ' + remotePaths.join(', ') + '. Last error: ' + (errors[errors.length - 1] || '-')));
        }
        const rp = remotePaths[i++];
        sftp.stat(rp, (statErr, st) => {
          if (statErr || !st || !st.size) {
            errors.push(`${rp}: ${statErr ? statErr.message : 'empty/not file'}`);
            return tryNext();
          }
          sftp.fastGet(rp, localPath, (e) => {
            if (!e) return resolve(rp);
            errors.push(`${rp}: ${e.message || e}`);
            tryNext();
          });
        });
      };
      tryNext();
    });
  });
}

function sftpFastPut(conn, localPath, remotePaths) {
  const paths = Array.isArray(remotePaths) ? remotePaths : [remotePaths];
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      let i = 0;
      const errors = [];
      const tryNext = () => {
        if (i >= paths.length) return reject(new Error('Upload restore file failed. Tried: ' + paths.join(', ') + '. Last error: ' + (errors[errors.length - 1] || '-')));
        const rp = paths[i++];
        sftp.fastPut(localPath, rp, (e) => {
          if (!e) return resolve(rp);
          errors.push(`${rp}: ${e.message || e}`);
          tryNext();
        });
      };
      tryNext();
    });
  });
}

function psSingleQuote(s) {
  return String(s).replace(/'/g, "''");
}

async function downloadWindowsFileViaPowerShell(conn, remotePath, localPath) {
  const script = `
$ErrorActionPreference = 'Stop'
$profile = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($profile)) { $profile = [Environment]::GetFolderPath('UserProfile') }
if ([string]::IsNullOrWhiteSpace($profile)) { $profile = 'C:\\Users\\Administrator' }

$p = Join-Path $profile 'kcs_backup.zip'

if (!(Test-Path $p)) {
  Write-Output ('DEBUG_PROFILE=' + $profile)
  Write-Output ('DEBUG_TRY=' + $p)
  if (Test-Path $profile) {
    $names = Get-ChildItem -Path $profile -Force | ForEach-Object { $_.Name }
    Write-Output ('DEBUG_FILES=' + ([string]::Join(',', $names)))
  }
  throw ('file not found: ' + $p)
}

Write-Output ('BACKUP_FILE=' + $p)
Write-Output ('BACKUP_SIZE=' + ((Get-Item $p).Length))
[Convert]::ToBase64String([IO.File]::ReadAllBytes($p))
`;
  const res = await sshExec(conn, psEncodedCommand(script), DEFAULT_TIMEOUT);
  const raw = String(res.stdout || '');
  const b64 = raw
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => /^[A-Za-z0-9+/=]+$/.test(x) && x.length > 50)
    .join('');
  if (!b64 || b64.length < 20) {
    throw new Error('PowerShell base64 download returned empty output. Output: ' + raw.slice(0, 800));
  }
  fs.writeFileSync(localPath, Buffer.from(b64, 'base64'));
  if (!fs.existsSync(localPath) || fs.statSync(localPath).size <= 0) {
    throw new Error('Downloaded backup file is empty');
  }
  return remotePath || 'USERPROFILE\\\\kcs_backup.zip';
}

async function tryDownloadWindowsBackup(conn, remotePaths, localPath, fallbackPath) {
  try {
    return await sftpFastGet(conn, remotePaths, localPath);
  } catch (sftpErr) {
    // Fallback untuk Windows OpenSSH: kadang SFTP tidak bisa membaca path Windows,
    // tapi file bisa dibaca dari PowerShell via SSH.
    return await downloadWindowsFileViaPowerShell(conn, fallbackPath, localPath);
  }
}

function uniq(arr) {
  return Array.from(new Set(
    (arr || [])
      .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
      .map(v => String(v))
  ));
}

function getAccess(vps) {
  if (isRdpInstance(vps)) {
    const usernames = process.env.RDP_BACKUP_USER
      ? [process.env.RDP_BACKUP_USER]
      : ['Administrator', 'administrator'];

    // Untuk RDP:
    // - renter_instances punya rdp_password
    // - vps_instances lama memakai root_password
    // - vps_instances patch baru menyimpan password Windows di root_password
    const passwords = uniq([
      process.env.RDP_BACKUP_PASSWORD,
      vps.rdp_password,
      vps.root_password
    ]);

    const candidates = [];
    for (const username of usernames) {
      for (const password of passwords) candidates.push({ username, password });
    }
    return { kind: 'windows', candidates };
  }

  return {
    kind: 'linux',
    candidates: [{
      username: process.env.VPS_BACKUP_USER || 'root',
      password: vps.root_password
    }]
  };
}

async function connectWithAccess(vps, actionLabel, opts = {}) {
  const access = getAccess(vps);
  let lastErr = null;

  if (access.kind === 'windows' && opts.password) {
    access.candidates.unshift({
      username: opts.username || process.env.RDP_BACKUP_USER || 'Administrator',
      password: opts.password
    });
  }

  for (const cred of access.candidates) {
    try {
      const conn = await sshConnect({
        host: vps.ip,
        username: cred.username,
        password: cred.password,
        timeoutMs: 30000
      });
      return { conn, access, credential: cred };
    } catch (e) {
      lastErr = e;
    }
  }

  if (access.kind === 'windows') {
    throw new Error(`${actionLabel} RDP gagal: OpenSSH/port 22 belum aktif, atau password Windows/RDP yang tersimpan tidak cocok. ` +
      `Pastikan bisa login dari VPS bot dengan: ssh Administrator@${vps.ip}. ` +
      `Kalau RDP ini dibuat dari script lama, lakukan rebuild/create ulang dengan script terbaru agar password RDP tersimpan. ` +
      `Detail: ${lastErr?.message || lastErr}`);
  }

  throw lastErr || new Error('SSH login gagal');
}

function psEncodedCommand(script) {
  const encoded = Buffer.from(String(script), 'utf16le').toString('base64');
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

function windowsBackupCommand() {
  const script = `
$ErrorActionPreference = 'Stop'
$profile = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($profile)) { $profile = [Environment]::GetFolderPath('UserProfile') }
if ([string]::IsNullOrWhiteSpace($profile)) { $profile = 'C:\\Users\\Administrator' }

$dest = Join-Path $profile 'kcs_backup.zip'
Remove-Item $dest -Force -ErrorAction SilentlyContinue

$desktop = Join-Path $profile 'Desktop'
New-Item -ItemType Directory -Force -Path $desktop | Out-Null
$marker = Join-Path $desktop 'backup_marker.txt'
Set-Content -Path $marker -Value ('Backup marker ' + (Get-Date)) -ErrorAction SilentlyContinue

$paths = @()
foreach ($n in @('Desktop','Documents','Downloads')) {
  $p = Join-Path $profile $n
  if (Test-Path $p) { $paths += $p }
}

if ($paths.Count -eq 0) {
  throw 'No backup folders found in profile: ' + $profile
}

Compress-Archive -Path $paths -DestinationPath $dest -Force

if (!(Test-Path $dest)) { throw 'backup zip not created: ' + $dest }
$size = (Get-Item $dest).Length
if ($size -le 0) { throw 'backup zip is empty: ' + $dest }

Write-Output ('BACKUP_PATH=' + $dest)
Write-Output ('BACKUP_SIZE=' + $size)
`;
  return psEncodedCommand(script);
}

function linuxBackupCommand() {
  return `set -e; rm -f /tmp/kcs_backup.zip; cd /; if ! command -v zip >/dev/null 2>&1; then (apt-get update -y >/dev/null 2>&1 && apt-get install -y zip >/dev/null 2>&1) || (yum install -y zip >/dev/null 2>&1) || true; fi; if command -v zip >/dev/null 2>&1; then zip -r -q /tmp/kcs_backup.zip root home var/www etc/nginx etc/apache2 2>/tmp/kcs_backup_err.log || true; else tar -czf /tmp/kcs_backup.zip root home var/www etc/nginx etc/apache2 2>/tmp/kcs_backup_err.log || true; fi; test -s /tmp/kcs_backup.zip; echo BACKUP_OK`;
}

async function createBackup(instanceId, opts = {}) {
  await ensureTables();
  const vps = await getManagedServer(instanceId);
  if (!vps || Number(vps.status) !== 1) throw new Error('Server tidak ditemukan / tidak aktif');
  if (!vps.ip || !vps.root_password) throw new Error('IP atau password server tidak tersedia');

  const type = serverType(vps);
  const dir = backupDir(type, instanceId);
  ensureDir(dir);
  const tmpLocal = path.join(dir, `backup_${Date.now()}.zip`);
  const finalLocal = latestPath(type, instanceId);

  let conn;
  try {
    const connected = await connectWithAccess(vps, 'Backup', opts);
    conn = connected.conn;
    const connectedAccess = connected.access;
    if (connectedAccess.kind === 'windows') {
      await sshExec(conn, windowsBackupCommand(), DEFAULT_TIMEOUT);
      const winUser = process.env.RDP_BACKUP_USER || 'Administrator';
      await tryDownloadWindowsBackup(conn, [
        `/C:/Users/${winUser}/kcs_backup.zip`,
        `C:/Users/${winUser}/kcs_backup.zip`,
        `/Users/${winUser}/kcs_backup.zip`,
        `Users/${winUser}/kcs_backup.zip`,
        'kcs_backup.zip',
        '/C:/kcs_backup.zip',
        'C:/kcs_backup.zip'
      ], tmpLocal, null);
    } else {
      await sshExec(conn, linuxBackupCommand(), DEFAULT_TIMEOUT);
      await sftpFastGet(conn, ['/tmp/kcs_backup.zip'], tmpLocal);
    }
  } catch (e) {
    try { if (conn) conn.end(); } catch (_) {}
    await db.run(`INSERT INTO server_backups (instance_id, user_id, type, ip, enabled, last_error, updated_at)
                  VALUES (?, ?, ?, ?, 1, ?, ?)
                  ON CONFLICT(instance_id) DO UPDATE SET last_error=excluded.last_error, updated_at=excluded.updated_at`,
      [instanceId, vps.user_id, type, vps.ip, String(e.message || e).slice(0, 500), nowSec()]);
    try { if (fs.existsSync(tmpLocal)) fs.unlinkSync(tmpLocal); } catch (_) {}
    throw e;
  } finally {
    try { if (conn) conn.end(); } catch (_) {}
  }

  const size = fs.statSync(tmpLocal).size;
  if (fs.existsSync(finalLocal)) fs.unlinkSync(finalLocal);
  fs.renameSync(tmpLocal, finalLocal);
  await db.run(`INSERT INTO server_backups (instance_id, user_id, type, ip, file_path, file_size, enabled, created_at, last_error, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?)
                ON CONFLICT(instance_id) DO UPDATE SET user_id=excluded.user_id, type=excluded.type, ip=excluded.ip, file_path=excluded.file_path, file_size=excluded.file_size, created_at=excluded.created_at, last_error=NULL, updated_at=excluded.updated_at`,
    [instanceId, vps.user_id, type, vps.ip, finalLocal, size, nowSec(), nowSec()]);
  return { ok: true, filePath: finalLocal, size, type, ip: vps.ip };
}

async function restoreLatestBackup(instanceId, opts = {}) {
  await ensureTables();
  const vps = await getManagedServer(instanceId);
  if (!vps || Number(vps.status) !== 1) throw new Error('Server tidak ditemukan / tidak aktif');
  const rec = await getBackupRecord(instanceId);
  const filePath = rec?.file_path || latestPath(serverType(vps), instanceId);
  if (!filePath || !fs.existsSync(filePath)) throw new Error('Backup belum tersedia');
  let conn;
  try {
    const connected = await connectWithAccess(vps, 'Restore', opts);
    conn = connected.conn;
    const connectedAccess = connected.access;
    if (connectedAccess.kind === 'windows') {
      const winUser = process.env.RDP_BACKUP_USER || 'Administrator';
      await sftpFastPut(conn, filePath, [
        `/C:/Users/${winUser}/kcs_restore.zip`,
        `C:/Users/${winUser}/kcs_restore.zip`,
        'kcs_restore.zip'
      ]);
      const restoreScript = `
$ErrorActionPreference = 'Stop'
$profile = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($profile)) { $profile = [Environment]::GetFolderPath('UserProfile') }
if ([string]::IsNullOrWhiteSpace($profile)) { $profile = 'C:\\Users\\Administrator' }
$src = Join-Path $profile 'kcs_restore.zip'
if (!(Test-Path $src)) { throw ('restore zip not found: ' + $src) }
Expand-Archive -Path $src -DestinationPath $profile -Force
Write-Output 'RESTORE_OK'
`;
      await sshExec(conn, psEncodedCommand(restoreScript), DEFAULT_TIMEOUT);
    } else {
      await sftpFastPut(conn, filePath, '/tmp/kcs_restore.zip');
      const cmd = `set -e; if ! command -v unzip >/dev/null 2>&1; then (apt-get update -y >/dev/null 2>&1 && apt-get install -y unzip >/dev/null 2>&1) || (yum install -y unzip >/dev/null 2>&1) || true; fi; cd /; if command -v unzip >/dev/null 2>&1; then unzip -o /tmp/kcs_restore.zip >/dev/null; else tar -xzf /tmp/kcs_restore.zip -C /; fi; echo RESTORE_OK`;
      await sshExec(conn, cmd, DEFAULT_TIMEOUT);
    }
    return { ok: true, type: serverType(vps), ip: vps.ip };
  } finally {
    try { if (conn) conn.end(); } catch (_) {}
  }
}

async function restoreBackupFile(instanceId, filePath, opts = {}) {
  await ensureTables();
  const vps = await getManagedServer(instanceId);
  if (!vps || Number(vps.status) !== 1) throw new Error('Server tidak ditemukan / tidak aktif');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('File restore tidak ditemukan');
  let conn;
  try {
    const connected = await connectWithAccess(vps, 'Restore', opts);
    conn = connected.conn;
    const connectedAccess = connected.access;
    if (connectedAccess.kind === 'windows') {
      const winUser = process.env.RDP_BACKUP_USER || 'Administrator';
      await sftpFastPut(conn, filePath, [
        `/C:/Users/${winUser}/kcs_restore.zip`,
        `C:/Users/${winUser}/kcs_restore.zip`,
        'kcs_restore.zip'
      ]);
      const restoreScript = `
$ErrorActionPreference = 'Stop'
$profile = $env:USERPROFILE
if ([string]::IsNullOrWhiteSpace($profile)) { $profile = [Environment]::GetFolderPath('UserProfile') }
if ([string]::IsNullOrWhiteSpace($profile)) { $profile = 'C:\\Users\\Administrator' }
$src = Join-Path $profile 'kcs_restore.zip'
if (!(Test-Path $src)) { throw ('restore zip not found: ' + $src) }
Expand-Archive -Path $src -DestinationPath $profile -Force
Write-Output 'RESTORE_OK'
`;
      await sshExec(conn, psEncodedCommand(restoreScript), DEFAULT_TIMEOUT);
    } else {
      await sftpFastPut(conn, filePath, '/tmp/kcs_restore.zip');
      const cmd = `set -e; if ! command -v unzip >/dev/null 2>&1; then (apt-get update -y >/dev/null 2>&1 && apt-get install -y unzip >/dev/null 2>&1) || (yum install -y unzip >/dev/null 2>&1) || true; fi; cd /; if command -v unzip >/dev/null 2>&1; then unzip -o /tmp/kcs_restore.zip >/dev/null; else tar -xzf /tmp/kcs_restore.zip -C /; fi; echo RESTORE_OK`;
      await sshExec(conn, cmd, DEFAULT_TIMEOUT);
    }
    return { ok: true, type: serverType(vps), ip: vps.ip };
  } finally {
    try { if (conn) conn.end(); } catch (_) {}
  }
}


async function deleteBackup(instanceId) {
  await ensureTables();
  const rec = await getBackupRecord(instanceId);
  const vps = await getManagedServer(instanceId);
  const type = rec?.type || serverType(vps || {});
  const dir = backupDir(type, instanceId);
  const fp = rec?.file_path || latestPath(type, instanceId);

  try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
  try { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  await db.run('DELETE FROM server_backups WHERE instance_id = ?', [instanceId]);
}

async function listAutoBackupTargets() {
  await ensureTables();
  const rows = [];

  try {
    const normal = await db.all(`SELECT vi.id
      FROM vps_instances vi
      LEFT JOIN server_backups sb ON sb.instance_id = vi.id
      WHERE vi.status = 1 AND COALESCE(sb.enabled, 1) = 1
      ORDER BY vi.id ASC`);
    rows.push(...(normal || []).map(r => ({ id: Number(r.id) })));
  } catch (_) {}

  try {
    const renter = await db.all(`SELECT ri.id
      FROM renter_instances ri
      LEFT JOIN server_backups sb ON sb.instance_id = -ri.id
      WHERE ri.status = 1 AND COALESCE(sb.enabled, 1) = 1
      ORDER BY ri.id ASC`);
    rows.push(...(renter || []).map(r => ({ id: -Math.abs(Number(r.id)) })));
  } catch (_) {}

  return rows;
}

let autoRunning = false;
async function runAutoBackups(bot = null) {
  if (process.env.ENABLE_AUTO_BACKUP !== '1') {
    return { disabled: true, message: 'Auto backup disabled' };
  }
  if (autoRunning) return;
  autoRunning = true;
  try {
    const rows = await listAutoBackupTargets();
    let active = 0, idx = 0;
    await new Promise((resolve) => {
      const next = () => {
        while (active < AUTO_CONCURRENCY && idx < rows.length) {
          const id = rows[idx++].id;
          active++;
          createBackup(id, { auto: true }).catch(e => console.warn('[AUTO BACKUP]', id, e.message || e)).finally(() => { active--; next(); });
        }
        if (idx >= rows.length && active === 0) resolve();
      };
      next();
    });
  } finally {
    autoRunning = false;
  }
}

module.exports = {
  ensureTables,
  createBackup,
  restoreLatestBackup,
  restoreBackupFile,
  deleteBackup,
  getBackupRecord,
  isAutoBackupEnabled,
  setAutoBackup,
  runAutoBackups,
  serverType,
  latestPath,
  backupKeyForSource,
  getManagedServer
};
