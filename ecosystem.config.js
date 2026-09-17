// Konfigurasi PM2 agar bot & website tetap hidup (auto-restart saat crash,
// dan otomatis jalan lagi setelah server reboot). Ini solusi error 521
// (Cloudflare "Web server is down") yang terjadi ketika proses web mati.
//
// Cara pakai (sekali saja):
//   npm install -g pm2          # kalau belum ada
//   pm2 start ecosystem.config.js
//   pm2 save                    # simpan daftar proses
//   pm2 startup                 # ikuti instruksi yang muncul agar auto-start saat boot
//
// Perintah harian:
//   pm2 status                  # lihat status
//   pm2 logs kobong-web         # lihat log web
//   pm2 restart kobong-web      # restart web
//   pm2 restart all
module.exports = {
  apps: [
    {
      name: 'kobong-bot',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'kobong-web',
      script: 'web/server.js',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' }
    }
  ]
};
