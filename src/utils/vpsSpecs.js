const { Client } = require('ssh2');

async function detectVPSSpecs(host, username, password, options = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      const commands = {
        memory: `free -h | grep "Mem:" | awk '{print $2}' && echo "---MB---" && free -m | grep "Mem:" | awk '{print $2}'`,
        disk: `df -h / | tail -1 | awk '{print $2}' && echo "---GB---" && df -BG / | tail -1 | awk '{gsub(/G/, "", $2); print $2}'`,
        cpu: `nproc && echo "---CORES---" && cat /proc/cpuinfo | grep "model name" | head -1 | cut -d':' -f2 | xargs`,
        hostname: `hostname && echo "---SHORT---" && hostname -s`,
        os: `lsb_release -d 2>/dev/null | cut -f2 || cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2`,
        uptime: `uptime -p 2>/dev/null || uptime | awk '{print $3,$4}' | sed 's/,//'`
      };

      let results = {};
      let completedCommands = 0;
      const totalCommands = Object.keys(commands).length;

      Object.entries(commands).forEach(([key, cmd]) => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
            results[key] = 'Unknown';
            completedCommands++;
            if (completedCommands === totalCommands) {
              conn.end();
              processResults();
            }
            return;
          }

          let output = '';
          stream.on('data', (data) => {
            output += data.toString();
          });

          stream.on('close', () => {
            results[key] = output.trim();
            completedCommands++;
            
            if (completedCommands === totalCommands) {
              conn.end();
              processResults();
            }
          });
        });
      });

      function processResults() {
        try {
          const memoryData = results.memory.split('---MB---');
          const diskData = results.disk.split('---GB---');
          const hostnameData = results.hostname.split('---SHORT---');
          const cpuData = results.cpu.split('---CORES---');

          const memoryGB = parseFloat(memoryData[1]) / 1024;
          const diskGB = parseInt(diskData[1]);
          const cpuCores = parseInt(cpuData[0]);

          const specs = {
            memory: memoryData[0],
            memoryMB: parseInt(memoryData[1]),
            memoryGB: Math.round(memoryGB * 100) / 100,
            disk: diskData[0],
            diskGB: diskGB,
            cpu: `${cpuCores} Core${cpuCores > 1 ? 's' : ''} - ${cpuData[1] || 'Unknown CPU'}`,
            cpuCores: cpuCores,
            cpuModel: cpuData[1] || 'Unknown',
            hostname: hostnameData[0] || 'unknown',
            hostname_short: hostnameData[1] || hostnameData[0] || 'unknown',
            os: results.os || 'Unknown OS',
            uptime: results.uptime || 'Unknown',
            meetsMinimumRequirements: {
              memory: memoryGB >= 1,
              disk: diskGB >= 20,
              cpu: cpuCores >= 1,
              overall: memoryGB >= 1 && diskGB >= 20 && cpuCores >= 1
            },
            formattedSpecs: {
              memory: `💾 RAM: ${memoryData[0]} (${Math.round(memoryGB * 100) / 100} GB)`,
              disk: `💽 Storage: ${diskData[0]} (${diskGB} GB)`,
              cpu: `⚡ CPU: ${cpuCores} Core${cpuCores > 1 ? 's' : ''}`
            }
          };

          resolve(specs);
        } catch (error) {
          reject(new Error(`Failed to process VPS specs: ${error.message}`));
        }
      }
    });

    conn.on('error', (err) => {
      reject(err);
    });

    const connectOptions = {
      host,
      port: 22,
      username,
      readyTimeout: 30000
    };
    if (options && options.privateKey) {
      connectOptions.privateKey = options.privateKey;
      if (options.passphrase) connectOptions.passphrase = options.passphrase;
    } else {
      connectOptions.password = password;
    }
    conn.connect(connectOptions);
  });
}

async function checkVPSRequirements(host, username, password, options = {}) {
  try {
    const specs = await detectVPSSpecs(host, username, password, options);
    
    return {
      success: true,
      specs: specs,
      meets_requirements: specs.meetsMinimumRequirements.overall,
      requirements_details: {
        memory: {
          current: specs.memoryGB,
          required: 1,
          status: specs.meetsMinimumRequirements.memory ? '✅' : '❌'
        },
        disk: {
          current: specs.diskGB,
          required: 20,
          status: specs.meetsMinimumRequirements.disk ? '✅' : '❌'
        },
        cpu: {
          current: specs.cpuCores,
          required: 1,
          status: specs.meetsMinimumRequirements.cpu ? '✅' : '❌'
        }
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      meets_requirements: false
    };
  }
}

module.exports = {
  detectVPSSpecs,
  checkVPSRequirements
};