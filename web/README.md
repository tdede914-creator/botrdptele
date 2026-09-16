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
