# GABUT — Telegram Bot RDP Installer + Multi Payment Gateway

Fork dari `BOTRDP` dengan tambahan support **Payment Gateway self-hosted (OrderKuota via PG-Donn-)**.

## Fitur

- Install RDP di VPS
- Order VPS / RDP / Cloud9 / Fastpanel (auto-deploy DigitalOcean / Linode / AWS)
- Shop produk digital
- Renter (bot rental)
- Multi payment gateway:
  - **OrderKuota** (self-hosted, tanpa fee pihak ketiga) — **NEW**
  - Pakasir
  - DompetX
  - Crypto USDT (Binance Personal API, BEP20)
- Withdraw ke rekening bank (via Atlantic H2H)

## Instalasi Cepat

```bash
git clone https://github.com/tdede914-creator/GABUT.git
cd GABUT
npm install
cp envrdpbot.txt .env
# edit .env sesuai kebutuhan
node src/index.js
```

## Payment Gateway

Pilih dengan env `PAYMENT_GATEWAY`:
- `orderkuota` — self-hosted, butuh [PG-Donn-](https://github.com/tdede914-creator/PG-Donn-) jalan di VPS
- `pakasir` — bayar per transaksi ke Pakasir
- `dompetx` — bayar per transaksi ke DompetX

### Setup OrderKuota (recommended)

Lihat [README-ORDERKUOTA.md](README-ORDERKUOTA.md) untuk panduan lengkap.

Ringkasnya:
1. Deploy [PG-Donn-](https://github.com/tdede914-creator/PG-Donn-) di VPS
2. Setup provider OrderKuota di dashboard PG (login pakai OTP)
3. Bikin API Key di dashboard PG
4. Isi 4 env di bot:
   ```env
   PAYMENT_GATEWAY=orderkuota
   ORDERKUOTA_PG_URL=http://IP-VPS-PG:3000
   ORDERKUOTA_PG_API_KEY=pk_xxx
   ORDERKUOTA_PG_SECRET=sk_xxx
   ORDERKUOTA_CALLBACK_URL=http://IP-VPS-BOT:3001/orderkuota/webhook
   ```
5. Jalankan bot + webhook receiver:
   ```bash
   pm2 start src/index.js --name gabut-bot
   pm2 start src/webhookServer.js --name gabut-webhook
   pm2 save
   ```

## Attribution

- Original bot code by [tdede914-creator/BOTRDP](https://github.com/tdede914-creator/BOTRDP).
- OrderKuota integration via [PG-Donn-](https://github.com/tdede914-creator/PG-Donn-) which ports [tdede914-creator/orderkuota-api](https://github.com/tdede914-creator/orderkuota-api) (fork of `yuf1dev/orderkuota-api`, MIT).

## License

Same as upstream BOTRDP.
