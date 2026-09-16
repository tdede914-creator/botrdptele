const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeLf(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function shellSingleQuote(v) {
  return `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Install Fastpanel on a remote host via SSH.
 *
 * Options:
 *  - fastpanelUser: desired admin user (default: 'fastuser')
 *  - fastpanelPassword: desired admin password (default: auto-generated inside script)
 *  - port: SSH port (default: 22)
 *  - sshMaxWaitMs: maximum time to wait for SSH to become ready (default: 10 min)
 *  - sshRetryIntervalMs: SSH retry interval (default: 15s)
 *  - timeoutMs: total execution timeout (default: 45 min)
 *
 * Returns: { success: true, port: '8888', username, password, url, output }
 */
async function installFastpanel(host, username = 'root', password, options = {}, onLog = null) {
  const maxWaitMs = options.sshMaxWaitMs ?? 10 * 60 * 1000;
  const retryEveryMs = options.sshRetryIntervalMs ?? 15 * 1000;
  const deadline = Date.now() + maxWaitMs;
  let lastErr;

  while (Date.now() < deadline) {
    try {
      return await runOnce(host, username, password, options, onLog);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err || '');
      const level = String(err?.level || '');
      const retryable = /All configured authentication methods failed|Authentication failure|Permission denied|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|socket hang up/i.test(msg) ||
                        /client-authentication|client-socket|client-timeout/i.test(level);
      if (!retryable) throw err;
      if (onLog) onLog(`⚠️ SSH belum siap: ${msg.slice(0, 120)}. Retry ${Math.round(retryEveryMs / 1000)}s...`);
      await sleep(retryEveryMs);
    }
  }

  throw lastErr || new Error('SSH tidak siap dalam batas waktu.');
}

function runOnce(host, username, password, options, onLog) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const tail = [];
    const maxTail = 400;
    const scriptPath = path.join(__dirname, '../../scripts/fastpanel_install.sh');
    const scriptContent = normalizeLf(fs.readFileSync(scriptPath, 'utf8'));
    const remotePath = '/tmp/fastpanel_install.sh';
    const timeoutMs = options.timeoutMs ?? 45 * 60 * 1000;
    const fpUser = String(options.fastpanelUser || 'fastuser').replace(/[^a-zA-Z0-9_.-]/g, '') || 'fastuser';
    const fpPass = String(options.fastpanelPassword || '').trim();
    let done = false;

    const log = (m) => { if (onLog) onLog(m); };

    const finish = (err, result) => {
      if (done) return;
      done = true;
      try { conn.end(); } catch (_) {}
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      finish(new Error('Timeout instalasi Fastpanel. Tail log:\n' + tail.slice(-30).join('\n')));
    }, timeoutMs);

    conn.on('ready', () => {
      log('✅ SSH connected. Upload fastpanel_install.sh...');
      conn.sftp((err, sftp) => {
        if (err) { clearTimeout(timer); return finish(err); }

        const ws = sftp.createWriteStream(remotePath, { mode: 0o755 });
        ws.on('error', (e) => { clearTimeout(timer); finish(e); });
        ws.on('close', () => {
          log('✅ Script Fastpanel uploaded. Running installer...');

          const envPrefix = `FP_USER=${shellSingleQuote(fpUser)} ` +
                            (fpPass ? `FP_PASS=${shellSingleQuote(fpPass)} ` : '');
          const cmd = `sed -i 's/\\r$//' ${remotePath}; chmod +x ${remotePath}; ${envPrefix}bash ${remotePath}`;

          conn.exec(cmd, { pty: true }, (err, stream) => {
            if (err) { clearTimeout(timer); return finish(err); }

            let output = '';
            const push = (chunk) => {
              const text = String(chunk || '').replace(/\r/g, '');
              output += text;
              for (const line of text.split('\n').filter(Boolean)) {
                tail.push(line);
                if (tail.length > maxTail) tail.shift();
                log(line);
              }
            };

            stream.on('data', push);
            stream.stderr.on('data', push);
            stream.on('close', (code) => {
              clearTimeout(timer);
              const success = /(^|\n)SUCCESS(\r?\n|$)/.test(output);
              const port = (output.match(/PORT=([^\n\r]+)/) || [])[1] || '8888';
              const fUser = (output.match(/FP_USER=([^\n\r]+)/) || [])[1] || fpUser;
              const fPass = (output.match(/FP_PASS=([^\n\r]+)/) || [])[1] || fpPass || '';
              const fUrl  = (output.match(/FP_URL=([^\n\r]+)/) || [])[1] || `https://${host}:${port}/`;

              if (success && fPass) {
                return finish(null, {
                  success: true,
                  port: String(port).trim(),
                  username: String(fUser).trim(),
                  password: String(fPass).trim(),
                  url: String(fUrl).trim(),
                  output
                });
              }
              // Show more of the tail on failure so admin/user can diagnose.
              // 120 lines usually covers dump_diagnostics output from the shell script.
              return finish(new Error(
                `Instalasi Fastpanel gagal. Exit code: ${code}.\n` +
                tail.slice(-120).join('\n')
              ));
            });
          });
        });

        ws.end(scriptContent);
      });
    });

    conn.on('error', (err) => { clearTimeout(timer); finish(err); });

    conn.connect({
      host,
      port: Number(options.port || 22),
      username,
      password,
      readyTimeout: 30000,
      keepaliveInterval: 10000
    });
  });
}

module.exports = { installFastpanel };
