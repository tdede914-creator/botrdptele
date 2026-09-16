const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function normalizeLf(s) {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Install Windows RDP by uploading tele.sh then executing it.
 *
 * Behavior:
 * - Normalizes tele.sh line endings (CRLF -> LF).
 * - During reinstall, SSH can drop / reboot; ssh2 may report exit code as undefined/null.
 *   In that case, we treat it as "started successfully / rebooting" (success path).
 * - For fresh droplets, password-auth / root login may not be ready immediately (cloud-init still running).
 *   We retry authentication and transient socket failures for a bounded time.
 */
async function installDedicatedRDP(host, username, password, config, onLog) {
  // Linode butuh jendela retry SSH lebih panjang: boot Ubuntu awal + cloud-init
  // (bila region mendukung Metadata) bisa memakan waktu lebih lama sebelum
  // login root via password benar-benar siap.
  const isLinode = String(config?.provider || '').toLowerCase() === 'linode';
  const defaultMaxWaitMs = isLinode ? 12 * 60 * 1000 : 8 * 60 * 1000;
  const maxWaitMs = config?.sshMaxWaitMs ?? defaultMaxWaitMs;       // total time to keep trying SSH
  const retryEveryMs = config?.sshRetryIntervalMs ?? 15 * 1000;     // retry interval
  const deadline = Date.now() + maxWaitMs;

  let lastErr;

  while (Date.now() < deadline) {
    try {
      return await runOnce(host, username, password, config, onLog);
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) ? String(err.message) : '';
      const level = err && err.level ? String(err.level) : '';

      // Auth not ready / wrong auth method (common right after droplet creation)
      const isAuth = /All configured authentication methods failed|Authentication failure|Permission denied/i.test(msg) ||
                     /client-authentication/i.test(level);

      // Transient socket issues while booting/rebooting
      const isTransientNet = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|socket hang up/i.test(msg) ||
                             /client-socket|client-timeout/i.test(level);

      if (isAuth || isTransientNet) {
        if (onLog) onLog(`⚠️ SSH belum siap (${isAuth ? 'auth' : 'network'}). Retry dalam ${Math.round(retryEveryMs/1000)}s...`);
        await sleep(retryEveryMs);
        continue;
      }

      // Non-retryable error
      throw err;
    }
  }

  throw lastErr || new Error('SSH tidak siap dalam batas waktu.');
}

function runOnce(host, username, password, config, onLog) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let commandStarted = false;

    // Keep a small tail of remote output for better error reporting.
    // This is especially useful when tele.sh fails early (download issues, unsupported image, etc.).
    const tail = [];
    const TAIL_MAX_LINES = 40;
    const pushTail = (prefix, chunk) => {
      const s = String(chunk || '').replace(/\r/g, '');
      const lines = s.split('\n').filter(Boolean);
      for (const line of lines) {
        tail.push(`${prefix}${line}`);
        if (tail.length > TAIL_MAX_LINES) tail.shift();
      }
    };

    const teleShPath = path.join(__dirname, '../../scripts/tele.sh');
    const reinstallLocalPath = path.join(__dirname, '../../scripts/reinstall.sh');
    let scriptContent = fs.readFileSync(teleShPath, 'utf8');
    scriptContent = normalizeLf(scriptContent);
    let reinstallContent = '';
    try {
      reinstallContent = normalizeLf(fs.readFileSync(reinstallLocalPath, 'utf8'));
    } catch (_) {
      reinstallContent = '';
    }

    // Optional: OS version parameter passed into tele.sh via env
    const osVersion = config?.osVersion || '';
    const windowsPassword = config?.password || '';

    const privateKey = config?.privateKey || null;
    const useSudo = !!config?.useSudo || (!!privateKey && username !== 'root');
    const remotePath = useSudo ? '/tmp/tele.sh' : '/root/tele.sh';
    const remoteReinstallPath = useSudo ? '/tmp/reinstall.sh' : '/root/reinstall.sh';

    function log(m) { if (onLog) onLog(m); }

    conn.on('ready', () => {
      log('✅ Connected! Uploading script...');
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        const runInstaller = () => {
          log('✅  Script uploaded successfully!');
          const shellQuote = (value) => {
            const v = String(value ?? '');
            return `'${v.replace(/'/g, `'\\''`)}'`;
          };
          const qPass = shellQuote(windowsPassword || '');
          const qOs = shellQuote(osVersion || '');
          const qProvider = shellQuote(config?.provider || config?.providerName || config?.cloudProvider || '');
          const basePrep = `sed -i 's/\\r$//' ${remotePath} ${remoteReinstallPath} 2>/dev/null || true; chmod +x ${remotePath} ${remoteReinstallPath} 2>/dev/null || true`;
          let cmd;
          if (useSudo) {
            // AWS/EC2 biasanya login sebagai ubuntu/ec2-user memakai SSH key. Script reinstall wajib root,
            // jadi salin script ke /root lalu jalankan via sudo env agar root + environment tetap masuk.
            cmd = `${basePrep}; sudo -n install -m 755 ${remotePath} /root/tele.sh; sudo -n install -m 755 ${remoteReinstallPath} /root/reinstall.sh 2>/dev/null || true; sudo -n env WIN_PASS=${qPass} IMG_VERSION=${qOs} INSTALL_PROVIDER=${qProvider} bash /root/tele.sh ${qPass} ${qOs}`;
          } else {
            cmd = `${basePrep}; WIN_PASS=${qPass} IMG_VERSION=${qOs} INSTALL_PROVIDER=${qProvider} bash ${remotePath} ${qPass} ${qOs}`;
          }
          log('🚀 Executing installation command...');
          conn.exec(cmd, (err, stream) => {
            if (err) {
              conn.end();
              return reject(err);
            }

            stream.on('close', (code, signal) => {
              if (code === undefined || code === null) {
                commandStarted = true;
                log('🔄 SSH terputus (reboot/reinstall). Dianggap instalasi sudah berjalan...');
                conn.end();
                return resolve({ started: true, rebooting: true });
              }

              if (code !== 0) {
                conn.end();
                return reject(new Error('Installation failed'));
              }

              commandStarted = true;
              conn.end();
              return resolve({ started: true, rebooting: false });
            });

            stream.on('data', (data) => {
              const s = data.toString();
              pushTail('', s);
              const m = s.match(/(\d{1,3})%/);
              if (m) log(`⏳  Installation progress: ${m[1]}%`);
              else log(`⚠️ ${s.trim()}`);
            });

            stream.stderr.on('data', (data) => {
              const s = data.toString().trim();
              pushTail('ERR: ', data.toString());
              if (s) log(`⚠️ ${s}`);
            });
          });
        };

        const uploadTele = () => {
          const writeStream = sftp.createWriteStream(remotePath, { mode: 0o755 });
          writeStream.on('close', () => {
            if (!reinstallContent) return runInstaller();
            const reinstallStream = sftp.createWriteStream(remoteReinstallPath, { mode: 0o755 });
            reinstallStream.on('close', runInstaller);
            reinstallStream.on('error', (err) => {
              log('⚠️ Gagal upload reinstall lokal, lanjut download dari remote...');
              runInstaller();
            });
            reinstallStream.write(reinstallContent);
            reinstallStream.end();
          });
          writeStream.on('error', (err) => {
            conn.end();
            return reject(err);
          });
          writeStream.write(scriptContent);
          writeStream.end();
        };

        uploadTele();
      });
    });

    conn.on('error', (err) => {
      // If error happens after command started, treat as reboot/disconnect success path
      if (commandStarted) {
        log('🔄 SSH disconnect setelah command dimulai. Dianggap instalasi berjalan...');
        return resolve({ started: true, rebooting: true });
      }
      return reject(err);
    });

    const connectOptions = {
      host,
      port: 22,
      username,
      readyTimeout: 45000,
      tryKeyboard: false,
      // Keepalive: jaga channel tetap hidup selama instalasi panjang yang "diam".
      // Tanpa ini, koneksi yang sebenarnya masih jalan bisa terputus dan salah
      // terbaca sebagai "reboot sukses". Dengan keepalive, putus = benar-benar reboot.
      keepaliveInterval: 20000,
      keepaliveCountMax: 6
    };
    if (config?.privateKey) {
      connectOptions.privateKey = config.privateKey;
      if (config.passphrase) connectOptions.passphrase = config.passphrase;
    } else {
      connectOptions.password = password;
    }
    conn.connect(connectOptions);
  });
}

module.exports = { installDedicatedRDP };
