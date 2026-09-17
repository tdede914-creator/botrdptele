const { Client } = require('ssh2');

async function checkVPSSupport(host, username, password) {
    return new Promise((resolve, reject) => {
        const conn = new Client();
        
        conn.on('ready', () => {
            // Check if KVM is supported
            conn.exec('ls -la /dev/kvm', (err, stream) => {
                if (err) {
                    conn.end();
                    reject(err);
                    return;
                }

                let output = '';
                stream.on('data', (data) => {
                    output += data.toString();
                });

                stream.on('close', (code) => {
                    conn.end();
                    const supported = code === 0 && output.includes('/dev/kvm');
                    resolve({ supported });
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
            readyTimeout: 10000
        });
    });
}

module.exports = {
    checkVPSSupport
};
