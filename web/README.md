# KOBONG CLOUD SERVER — Web App

Website fungsional yang **berbagi database & logika** dengan bot Telegram. Fokus fitur: **Order RDP** (auto-create + auto-install) dan **Install RDP** (di VPS milik user), plus saldo & **deposit QRIS**. Semua data (stok, saldo, order) tersinkron dengan bot karena memakai file `src/rdp.db` dan modul yang sama.

## Menjalankan

Website dan bot **harus berada di server yang sama** (berbagi file SQLite `src/rdp.db`).

```bash
# 1. Pastikan dependency sudah terpasang (sama dengan bot)
npm install

# 2. Lengkapi .env (lihat .env.example). Yang penting untuk web:
#    TELEGRAM_BOT_TOKEN=...        (untuk verifikasi Telegram Login)
#    TELEGRAM_BOT_USERNAME=NamaBot (tanpa @, untuk tombol login)
#    WEB_SESSION_SECRET=<string acak panjang>
#    WEB_PORT=3000
#    WEB_PUBLIC_URL=https://domain-anda.com
#    DOMPETX_API_KEY=...           (untuk deposit QRIS)

# 3. Jalankan bot (proses terpisah) — seperti biasa
npm start

# 4. Jalankan website (proses terpisah)
npm run web
# -> http://localhost:3000
```

## PENTING: Aktifkan Telegram Login untuk domain kamu

Telegram Login Widget hanya berfungsi bila domain website sudah didaftarkan ke bot:

1. Buka **@BotFather** → `/setdomain` → pilih bot kamu → kirim domain (mis. `kobong.example.com`).
2. Widget hanya muncul di domain terdaftar (untuk uji lokal, Telegram tidak mengizinkan `localhost`; gunakan tunnel seperti Cloudflare Tunnel/ngrok yang mengarah ke domain terdaftar, atau deploy ke domain asli).

## Konkurensi database (bot + web)

`web/db.js` mengaktifkan `PRAGMA journal_mode=WAL` dan `busy_timeout` agar bot & web bisa membaca/menulis `rdp.db` bersamaan tanpa `SQLITE_BUSY`. WAL bersifat persisten pada file DB.

## Arsitektur singkat

- `web/server.js` — HTTP server (modul bawaan Node, tanpa framework), routing API + static.
- `web/auth.js` — verifikasi Telegram Login (HMAC bot token) + cookie sesi ber-tanda-tangan.
- `web/db.js` — reuse koneksi SQLite bot + WAL.
- `web/services/rdpService.js` — katalog RDP, order (auto-provision), install manual, daftar RDP user.
- `web/services/depositService.js` — deposit QRIS (reuse gateway & BalanceManager bot).
- `web/public/` — frontend (HTML/CSS/JS vanilla), branding KOBONG CLOUD SERVER.

## Endpoint API (ringkas)

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/config` | username bot (untuk widget) |
| POST | `/api/auth/telegram` | login via Telegram, set cookie sesi |
| POST | `/api/auth/logout` | logout |
| GET | `/api/me` | saldo & info user |
| GET | `/api/rdp/products` | katalog paket RDP (sinkron bot) |
| GET | `/api/rdp/options` | region + OS + harga untuk paket/durasi |
| POST | `/api/rdp/order` | buat + install RDP otomatis |
| POST | `/api/rdp/install` | install RDP di VPS milik user |
| GET | `/api/job/:id` | status provisioning/instalasi |
| GET | `/api/rdp/mine` | daftar RDP milik user |
| GET | `/api/tx` | riwayat transaksi saldo |
| POST | `/api/deposit` | buat tagihan QRIS |
| GET | `/api/deposit/status` | cek status & kredit saldo |

> Catatan: uji runtime penuh perlu environment dengan native module `sqlite3`/`ssh2` terpasang (`npm install`).


## Mengatasi error 521 (Web server is down)

Error 521 Cloudflare = origin (proses web) **tidak merespons** — biasanya karena proses `node web/server.js` mati (SSH ditutup, crash, atau server reboot). Karena itu "restart baru normal lagi". Solusi permanen: jalankan lewat **PM2** (auto-restart + tahan reboot).

```bash
npm install -g pm2
pm2 start ecosystem.config.js   # menjalankan kobong-bot + kobong-web
pm2 save
pm2 startup                     # ikuti perintah yang ditampilkan (agar auto-start saat boot)
```

`web/server.js` juga sudah diberi handler `uncaughtException`/`unhandledRejection` agar satu error tak mematikan seluruh server. Kalau masih 521:
- Pastikan `pm2 status` menunjukkan `kobong-web` **online** (bukan errored/stopped) → cek `pm2 logs kobong-web`.
- Pastikan Cloudflare (orange) menyambung ke port yang benar (reverse proxy 80/443 → `WEB_PORT`, atau `WEB_PORT=80`).

## Payment gateway Valqenix

Aktifkan di `.env`:
```
PAYMENT_GATEWAY=valqenix
VALQENIX_API_KEY=...           # dari dashboard Valqenix
VALQENIX_BASE_URL=https://app.valqenix.com
VALQENIX_CREATE_PATH=/api/v1/qris/create
VALQENIX_STATUS_PATH=/api/v1/qris/status
VALQENIX_AUTH_HEADER=Authorization
VALQENIX_AUTH_PREFIX=Bearer 
```
Endpoint/auth dibuat konfigurable karena spesifik tiap doc akun. Sesuaikan `VALQENIX_CREATE_PATH`/`VALQENIX_STATUS_PATH`/auth sesuai dokumentasi Anda bila berbeda dari default.


### Webhook Valqenix (opsional tapi disarankan)

Pembayaran sudah dikonfirmasi via **polling** (jalan tanpa webhook). Webhook membuatnya **instan + tahan restart**. Cara aktifkan:

1. Set di `.env`: `VALQENIX_WEBHOOK_SECRET=whsec_...` (dari dashboard Valqenix).
2. Di dashboard Valqenix → Webhook → **Destination address**: `https://DOMAIN-ANDA/webhooks/valqenix` (wajib HTTPS port 443, bukan IP/localhost).
3. Aktifkan webhook & simpan.

Server memverifikasi header `X-Valqenix-Signature` (`v1=HMAC_SHA256(timestamp.rawBody)`) dengan secret tersebut; event `payment.paid`/`payment.settled` otomatis memicu provisioning (checkout) atau kredit saldo (deposit).
