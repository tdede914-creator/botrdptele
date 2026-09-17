const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function isPm2() {
  return !!process.env.PM2_HOME || typeof process.env.pm_id !== 'undefined';
}

function scheduleRestart(delayMs = 1500) {
  if (isPm2()) {
    setTimeout(() => process.exit(0), delayMs);
    return 'pm2';
  }

  const projectRoot = path.join(__dirname, '../..');
  const logPath = path.join(projectRoot, 'bot-restart.log');

  setTimeout(() => {
    try {
      const out = fs.openSync(logPath, 'a');
      const child = spawn(process.execPath, [path.join(projectRoot, 'src/index.js')], {
        cwd: projectRoot,
        detached: true,
        stdio: ['ignore', out, out],
        env: process.env,
      });
      child.unref();
    } catch (err) {
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Auto restart failed: ${err.message}\n`);
      } catch (_) {}
    } finally {
      process.exit(0);
    }
  }, delayMs);

  return 'manual-detached';
}

module.exports = { isPm2, scheduleRestart };
