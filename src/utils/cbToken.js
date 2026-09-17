const crypto = require('crypto');

// -------------------------------------------------------------------------
// Callback token registry — fix Telegram 64-byte callback_data limit
// -------------------------------------------------------------------------
// Telegram Bot API menolak inline button dengan callback_data > 64 byte
// (error BUTTON_DATA_INVALID). Callback renter yang menggabungkan
// apiId + region + size slug + image slug bisa melewati batas ini, mis. Linode:
//
//   renter_vps_image:12:ap-southeast:g6-dedicated-8:linode/ubuntu24.04  (66 byte)
//
// Akibatnya tombol tidak terpasang / tidak merespons saat diklik — persis
// gejala "tombol next / halaman selanjutnya tidak jalan di beberapa region".
//
// Catatan: UpCloud sudah aman karena slug plan/image-nya sengaja dipendekkan
// di upcloudApi.js (mis. "up-4c-8g", "upcloud/ubuntu22"). Linode & AWS TIDAK
// dipendekkan, jadi util ini menutup sisa lubangnya untuk SEMUA provider.
//
// pack(value)    : string panjang / mengandung karakter tak aman → token pendek
//                  deterministik ("t" + 10 hex = 11 char). String pendek & aman
//                  dikembalikan apa adanya supaya callback tetap terbaca &
//                  backward-compatible dengan handler lama.
// resolve(token) : token → string asli. Kalau bukan token yang dikenal (mis.
//                  callback lama / string biasa), dikembalikan apa adanya.
//
// Registry disimpan di memori proses. Token bersifat deterministik dari hash,
// jadi region/size/image yang sama selalu menghasilkan token yang sama selama
// proses hidup. Cukup untuk alur pemilihan spesifikasi yang berlangsung dalam
// satu sesi bot.

const _tokenToValue = new Map();

// Threshold 10: region terpanjang Linode ("ap-southeast" = 12) ikut di-tokenize
// sehingga callback pagination pun dijamin jauh di bawah 64 byte.
const SAFE_MAX_LEN = 10;
const SAFE_CHARS = /^[A-Za-z0-9._-]+$/;

function pack(value) {
  const v = String(value == null ? '' : value);
  if (v.length <= SAFE_MAX_LEN && SAFE_CHARS.test(v)) return v;
  const token = 't' + crypto.createHash('sha1').update(v).digest('hex').slice(0, 10);
  _tokenToValue.set(token, v);
  return token;
}

function resolve(token) {
  const t = String(token == null ? '' : token);
  return _tokenToValue.has(t) ? _tokenToValue.get(t) : t;
}

module.exports = { pack, resolve };
