const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeLf(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function shellQuote(value) {
  const v = String(value ?? '');
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

async function installCloud9(host, username = 'root', password, options = {}, onLog = null) {
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
      if (onLog) onLog(`⚠️ SSH belum siap: ${msg.slice(0, 120)}. Retry ${Math.round(retryEveryMs/1000)}s...`);
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
    const scriptPath = path.join(__dirname, '../../scripts/x9.sh');
    const scriptContent = normalizeLf(fs.readFileSync(scriptPath, 'utf8'));
    const remotePath = '/tmp/x9.sh';
    const timeoutMs = options.timeoutMs ?? 45 * 60 * 1000;
    let done = false;

    function log(m) {
      if (onLog) onLog(m);
    }

    function finish(err, result) {
      if (done) return;
      done = true;
      try { conn.end(); } catch (_) {}
      if (err) reject(err);
      else resolve(result);
    }

    const timer = setTimeout(() => {
      finish(new Error('Timeout instalasi Cloud9. Tail log:\n' + tail.slice(-30).join('\n')));
    }, timeoutMs);

    conn.on('ready', () => {
      log('✅ SSH connected. Upload x9.sh...');
      conn.sftp((err, sftp) => {
        if (err) {
          clearTimeout(timer);
          return finish(err);
        }

        const ws = sftp.createWriteStream(remotePath, { mode: 0o755 });
        ws.on('error', (e) => {
          clearTimeout(timer);
          finish(e);
        });
        ws.on('close', () => {
          log('✅ Script Cloud9 uploaded. Running installer...');
          const cmd = `sed -i 's/\\r$//' ${remotePath}; chmod +x ${remotePath}; bash ${remotePath}`;
          conn.exec(cmd, { pty: true }, (err, stream) => {
            if (err) {
              clearTimeout(timer);
              return finish(err);
            }

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
              const success = /(^|\n)SUCCESS(\n|$)/.test(output);
              const port = (output.match(/PORT=([^\n\r]+)/) || [])[1] || '8000';
              const c9User = (output.match(/C9_USER=([^\n\r]+)/) || [])[1] || 'Admin';
              const c9Pass = (output.match(/C9_PASS=([^\n\r]+)/) || [])[1] || 'Donn0143';

              if (success || code === 0) {
                return finish(null, { success: true, port, username: c9User, password: c9Pass, output });
              }
              // Show more of the tail on failure so admin can see enough
              // context to diagnose (which step actually failed, apt errors,
              // wget URLs tried, etc.). 120 lines usually covers the full
              // failed step + a few preceding lines for context.
              return finish(new Error(`Instalasi Cloud9 gagal. Exit code: ${code}\n${tail.slice(-120).join('\n')}`));
            });
          });
        });

        ws.end(scriptContent);
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

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

module.exports = { installCloud9 };
