const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

async function checkKVMSupport(host, username, password, onLog) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      conn.exec('sudo apt install cpu-checker -y && sudo kvm-ok', (err, stream) => {
        if (err) {
          conn.end();
          reject(err);
          return;
        }
        
        let output = '';
        stream.on('data', (data) => {
          output += data;
          onLog && onLog(data.toString());
        });

        stream.stderr.on('data', (data) => {
          onLog && onLog(data.toString());
        });
        
        stream.on('close', (code) => {
          conn.end();
          if (code !== 0) {
            reject(new Error('Command failed with code ' + code));
            return;
          }
          resolve(output.includes('KVM acceleration can be used'));
        });
      });
    });

    conn.on('error', (err) => {
      reject(err);
    });

    conn.connect({
      host,
      port: 22,
      username,
      password,
      readyTimeout: 30000,
      tryKeyboard: false
    });
  });
}

async function installRDP(host, username, password, config, onLog) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', async () => {
      try {
        // Read the local rdp.sh script
        const scriptPath = path.join(__dirname, '../../scripts/rdp.sh');
        const scriptContent = fs.readFileSync(scriptPath, 'utf8');

        // Upload the script to the remote server
        await new Promise((resolve, reject) => {
          conn.sftp((err, sftp) => {
            if (err) reject(err);
            const writeStream = sftp.createWriteStream('/root/rdp.sh');
            writeStream.write(scriptContent);
            writeStream.end();
            writeStream.on('close', resolve);
            writeStream.on('error', reject);
          });
        });

        // Make the script executable and run it
        const command = `chmod +x /root/rdp.sh && echo -e "${config.windowsId}\n${config.ram}\n${config.cpu}\n${config.storage}\n${config.password}" | bash /root/rdp.sh && rm -f /root/rdp.sh`;

        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          let progress = 0;
          const progressInterval = setInterval(() => {
            progress += 5;
            if (progress <= 100) {
              onLog && onLog(`Setup process : [${'#'.repeat(progress/2)}${' '.repeat(50-progress/2)}] ${progress}%`);
            } else {
              clearInterval(progressInterval);
            }
          }, 3000);

          stream.on('data', (data) => {
            onLog && onLog(data.toString());
          });

          stream.stderr.on('data', (data) => {
            onLog && onLog(data.toString());
          });
          
          stream.on('close', (code) => {
            clearInterval(progressInterval);
            conn.end();
            if (code !== 0) {
              reject(new Error('Installation failed with code ' + code));
              return;
            }
            resolve(true);
          });
        });
      } catch (error) {
        conn.end();
        reject(error);
      }
    });

    conn.on('error', (err) => {
      reject(err);
    });

    conn.connect({
      host,
      port: 22,
      username,
      password,
      readyTimeout: 30000,
      tryKeyboard: false
    });
  });
}

module.exports = {
  checkKVMSupport,
  installRDP
};