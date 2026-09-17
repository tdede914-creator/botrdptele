# Setup Payment Gateway: OrderKuota (self-hosted PG-Donn-)

Bot ini support 3 payment gateway:
- **OrderKuota** (self-hosted via [PG-Donn-](https://github.com/tdede914-creator/PG-Donn-))
- Pakasir
- DompetX

Panduan ini fokus ke **OrderKuota**, karena itu yang paling murah (no fee per transaksi) dan sudah jadi default di bot ini.

> **Ringkasan singkat:**
> Bot ini mendeteksi pembayaran lewat **polling** (setiap 10 detik cek ke PG-Donn-). Jadi setup default cuma perlu 3 baris `.env` dan 1 proses. **Webhook itu opsional** (hanya untuk yang mau notifikasi < 1 detik).

---

## Prasyarat

Wajib:
1. **PG-Donn- sudah jalan di VPS** dengan provider OrderKuota terpasang & test connection sukses.
   Panduan install PG: <https://github.com/tdede914-creator/PG-Donn-/blob/main/deploy/SETUP-FROM-SCRATCH.md>
2. **API Key** dibuat di dashboard PG (menu API Keys) — dapat `pk_...` (public key).
   Kalau kamu mau pakai Mode B (Webhook), juga catat `sk_...` (secret).

---

# Mode A — Polling (recommended, paling simpel)

Bot cek status invoice ke PG-Donn- tiap 10 detik. Payment terdeteksi paling lambat 10 detik setelah user bayar. **Tidak butuh** port webhook, tidak butuh proses ke-2, tidak butuh firewall khusus.

### 1. Konfigurasi `.env`

```env
PAYMENT_GATEWAY=orderkuota
ORDERKUOTA_PG_URL=http://IP-VPS-PG:3000
ORDERKUOTA_PG_API_KEY=pk_xxxxxxxxxxxxxxxxxx
```

Ganti `IP-VPS-PG` dengan IP VPS yang menjalankan PG-Donn- (kalau di VPS yang sama dengan bot, pakai `127.0.0.1` atau `localhost`).

### 2. Jalankan bot

```bash
npm install
pm2 start src/index.js --name gabut-bot
pm2 save
```

**Selesai!** Coba `/start` di Telegram → **Deposit** → **QRIS** → masukkan nominal → scan → bayar. Bot akan detect & kredit saldo dalam max 10 detik.

---

# Mode B — Webhook (opsional, notifikasi lebih cepat)

Kalau kamu butuh notifikasi payment **< 1 detik** (bukan max 10 detik), tambahkan webhook. PG-Donn- akan POST langsung ke bot begitu invoice PAID.

> Sebagian besar user tidak butuh mode ini. Mode A sudah cukup untuk toko online normal.

### 1. `.env` (tambah 2 baris di bawah Mode A)

```env
PAYMENT_GATEWAY=orderkuota
ORDERKUOTA_PG_URL=http://IP-VPS-PG:3000
ORDERKUOTA_PG_API_KEY=pk_xxxxxxxxxxxxxxxxxx

# Webhook mode
ORDERKUOTA_PG_SECRET=sk_xxxxxxxxxxxxxxxxxxxxxxxx
ORDERKUOTA_CALLBACK_URL=http://IP-VPS-BOT:3001/orderkuota/webhook
```

- `sk_...` didapat saat bikin API Key di dashboard PG (**hanya muncul sekali** — kalau lupa, hapus & bikin baru).
- `IP-VPS-BOT` = IP VPS yang menjalankan bot ini. Kalau bot dan PG di VPS yang sama, pakai `127.0.0.1`.

### 2. Jalankan bot + webhook receiver (2 proses)

```bash
pm2 start src/index.js         --name gabut-bot
pm2 start src/webhookServer.js --name gabut-webhook
pm2 save
```

### 3. Buka firewall port webhook

Kalau PG dan bot di VPS **berbeda**, port `3001` di VPS bot harus di-expose:
```bash
ufw allow 3001/tcp
```

### 4. Verify webhook receiver hidup

```bash
curl http://localhost:3001/
# Harus balas: "Webhook server aktif. Endpoints: POST /dompetx/webhook, POST /orderkuota/webhook"
```

**Penting:** meskipun webhook aktif, **polling tetap jalan sebagai fallback**. Jadi kalau webhook gagal (mis. port diblokir), bot tetap kredit saldo lewat polling.

---

## Test End-to-End (kedua mode)

1. Buka bot di Telegram, ketik `/start`
2. Tap **Deposit** → **QRIS**
3. Masukkan nominal (mis. 1000)
4. Bot akan call PG-Donn- → dapat QRIS dinamis → kirim gambar QR ke chat
5. Scan QR pakai app e-wallet apapun → bayar sesuai total (nominal + kode unik)
6. Bot akan detect:
   - **Mode A:** dalam <= 10 detik via polling
   - **Mode B:** dalam < 1 detik via webhook (dengan polling sebagai fallback)
7. Bot kirim notif "Pembayaran Sukses"

---

## Troubleshooting

### Bot muncul "ORDERKUOTA_PG_URL belum diisi di .env"
File `.env` belum di-load. Cek:
```bash
grep -E '^(PAYMENT_GATEWAY|ORDERKUOTA_)' .env
```
Kalau kosong, buat/edit `.env` sesuai template.

### PG bilang "no active provider"
Di dashboard PG, kamu belum buat provider OrderKuota atau statusnya NONAKTIF. Buka menu **Providers** di dashboard PG, aktifkan atau bikin ulang (pakai tombol "Login OrderKuota (OTP)").

### Bayar sudah masuk tapi saldo user ga bertambah
1. Cek log bot: `pm2 logs gabut-bot --lines 100`
2. Cari baris `Payment Status Check` — kalau tidak ada, polling tidak jalan.
3. Cari baris `checkOrderkuotaStatus` error — biasanya URL PG salah atau PG down.
4. Cek `merchant_ref` waktu bikin invoice — pola default:
   - Deposit -> `DEP<timestamp><chatId>`
   - Shop order -> `ORD<timestamp><chatId>`
   - Rent order -> `RENT<timestamp><chatId>`

### Mode B: webhook selalu 401 "invalid signature"
Nilai `ORDERKUOTA_PG_SECRET` di bot **HARUS SAMA** dengan `sk_...` yang muncul saat bikin API Key di dashboard PG. Kalau lupa/hilang, hapus API key lama & bikin baru di dashboard PG.

### Mau balik ke Pakasir / DompetX
Cukup ubah `.env`:
```env
PAYMENT_GATEWAY=pakasir     # atau dompetx
```
Restart bot: `pm2 restart gabut-bot`. Handler pembayaran otomatis dispatch ke gateway yang aktif.

Catatan: Pakasir juga cuma pakai polling (tidak butuh webhook receiver). DompetX secara historis pakai webhook, jadi kalau balik ke DompetX butuh `webhookServer.js` jalan.

---

## Arsitektur Ringkas

### Mode A — Polling (default)

```
[User Telegram]
     |  /topup -> Deposit -> QRIS -> input nominal
     v
[Bot RDP]  -- createPayment() -->  [PG-Donn-]
     |                                    |  (PG polling OrderKuota mutasi)
     |  <-- setInterval 10s -- GET ------ |
     |       checkPaymentStatus()          |
     |       -> status: PAID?              |
     |                                    |
     v
[Bot kredit saldo + kirim notif "Pembayaran Sukses"]
```

### Mode B — Webhook + Polling fallback

```
[User Telegram]
     |  bayar QRIS
     v
[PG-Donn-] - detect PAID di OrderKuota
     |  1. POST /orderkuota/webhook (X-Signature HMAC)
     v
[webhookServer.js @ port 3001]
     |  verify HMAC -> cari pending -> kredit saldo -> hapus pending
     |  (deposit langsung; shop/renter di-handle polling)
     v
[Bot RDP] -- kirim notif "Pembayaran Sukses"

     -/+ (polling loop tetap jalan sebagai fallback,
          auto-kredit kalau webhook gagal)
```

---

Selamat, bot kamu sekarang pakai payment gateway sendiri — **tanpa biaya per transaksi, tanpa depend pihak ketiga**.
