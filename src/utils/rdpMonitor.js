const { Client } = require('ssh2');
const net = require('net');

class RDPMonitor {
    constructor(host, username, password, rdpPassword, rdpPort = 3389) {
        this.host = host;
        this.username = username;
        this.password = password;
        this.rdpPassword = rdpPassword;
        this.rdpPort = rdpPort;
        this.sshConnection = null;
    }

    async testRDPConnection() {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            const timeout = 5000;
            const startTime = Date.now();

            socket.setTimeout(timeout);

            socket.on('connect', () => {
                const responseTime = Date.now() - startTime;
                socket.destroy();
                resolve({
                    success: true,
                    message: `✅ RDP port ${this.rdpPort} is accessible (${responseTime}ms)`,
                    responseTime: responseTime
                });
            });

            socket.on('error', (err) => {
                socket.destroy();
                resolve({
                    success: false,
                    message: `❌ RDP connection failed: ${err.message}`,
                    error: err.message
                });
            });

            socket.on('timeout', () => {
                socket.destroy();
                resolve({
                    success: false,
                    message: `⏰ Connection timeout after ${timeout}ms`
                });
            });

            socket.connect(this.rdpPort, this.host);
        });
    }

    async waitForRDPReady(timeoutMs = 15 * 60 * 1000, onStatusUpdate = null) {
        const startTime = Date.now();
        const maxRetries = Math.max(1, Math.floor(timeoutMs / 30000));
        let retryCount = 0;

        onStatusUpdate && onStatusUpdate(`🔍 Starting RDP monitoring for ${this.host}:${this.rdpPort}...`);

        while (retryCount < maxRetries) {
            try {
                const testResult = await this.testRDPConnection();
                const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

                if (testResult.success) {
                    onStatusUpdate && onStatusUpdate(`🎉 RDP is ready! Response time: ${testResult.responseTime}ms`);
                    return {
                        success: true,
                        rdpReady: true,
                        totalTime: elapsedMinutes,
                        responseTime: testResult.responseTime,
                        message: `✅ RDP is ready and accessible (${testResult.responseTime}ms response time)`
                    };
                }

                retryCount++;
                const remainingRetries = maxRetries - retryCount;
                const nextCheckIn = 30; // seconds
                
                onStatusUpdate && onStatusUpdate(
                    `⏳ Attempt ${retryCount}/${maxRetries} - ${testResult.message}\n` +
                    `⏰ Elapsed: ${elapsedMinutes}m ${elapsedSeconds % 60}s\n` +
                    `🔄 Next check in ${nextCheckIn}s (${remainingRetries} attempts remaining)`
                );

                if (retryCount < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 30000));
                }

            } catch (error) {
                console.error('Error testing RDP:', error);
                retryCount++;
                const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
                
                onStatusUpdate && onStatusUpdate(
                    `⚠️ Error testing RDP: ${error.message}\n` +
                    `⏰ Elapsed: ${elapsedMinutes} minutes\n` +
                    `🔄 Retrying in 30 seconds...`
                );
                
                if (retryCount < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 30000));
                }
            }
        }

        const elapsedMinutes = Math.floor((Date.now() - startTime) / 60000);
        onStatusUpdate && onStatusUpdate(`⏰ Monitoring timeout after ${elapsedMinutes} minutes`);
        
        return {
            success: false,
            rdpReady: false,
            totalTime: elapsedMinutes,
            message: `RDP belum connect setelah ${elapsedMinutes} menit. Instalasi dianggap gagal.`
        };
    }

    disconnect() {
        if (this.sshConnection) {
            this.sshConnection.end();
            this.sshConnection = null;
        }
    }
}

module.exports = RDPMonitor;