/**
 * KOBONG CLOUD SERVER — Web App
 *
 * Server HTTP ringan (memakai modul bawaan Node `http`, TANPA dependency baru)
 * yang berbagi database & logika dengan bot Telegram. Fitur: login Telegram,
 * dashboard saldo & RDP, order RDP (auto-provision), install RDP (kredensial
 * manual VPS), dan deposit QRIS.
 */
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

require('./db'); // aktifkan WAL + busy_timeout, buka koneksi DB bersama
const db = require('./db');
const auth = require('./auth');
const rdpService = require('./services/rdpService');
const vpsService = require('./services/vpsService');
const cloud9Service = require('./services/cloud9Service');
const fastpanelService = require('./services/fastpanelService');
const depositService = require('./services/depositService');
const checkoutService = require('./services/checkoutService');
const accountService = require('./services/accountService');
const manageService = require('./services/manageService');
const { getUser, getBalance, isAdmin } = require('../src/utils/userManager');

const PORT = Number(process.env.WEB_PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
const SESSION_SECRET = process.env.WEB_SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!process.env.WEB_SESSION_SECRET) {
  console.warn('[web] WEB_SESSION_SECRET belum di-set — memakai secret acak (sesi akan hilang saat restart). Set di .env untuk produksi.');
}
if (!BOT_TOKEN) console.warn('[web] TELEGRAM_BOT_TOKEN belum di-set — login Telegram tidak akan berfungsi.');
if (!BOT_USERNAME) console.warn('[web] TELEGRAM_BOT_USERNAME belum di-set — tombol "Login with Telegram" tidak akan muncul.');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const COOKIE = 'kobong_session';

// ---------- helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let tooBig = false;
    req.on('data', (c) => { data += c; if (data.length > 1e6) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}
function readRawBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
function sessionUser(req) {
  const token = parseCookies(req)[COOKIE];
  const s = auth.verifySessionToken(token, SESSION_SECRET);
  return s ? s.tid : null;
}
function setSessionCookie(res, telegramId) {
  const token = auth.createSessionToken(telegramId, SESSION_SECRET);
  const maxAge = Math.floor(auth.SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}
function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : (urlPath === '/app' ? 'app.html' : urlPath.replace(/^\/+/, ''));
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA fallback ke app.html untuk rute tak dikenal (non-API)
      if (!path.extname(filePath)) return serveStatic(res, '/app');
      res.writeHead(404); return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    // Cegah cache basi (penyebab tampilan lama nyangkut). Browser wajib revalidasi.
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache, must-revalidate' });
    res.end(buf);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = parsed.pathname;

  try {
    // ---- Webhook Valqenix (verifikasi HMAC, butuh RAW body) ----
    if (p === '/webhooks/valqenix' && req.method === 'POST') {
      const raw = await readRawBody(req);
      const pg = require('../src/utils/paymentGateway');
      const sig = req.headers['x-valqenix-signature'];
      const ts = req.headers['x-valqenix-timestamp'];
      const evt = String(req.headers['x-valqenix-event'] || '');
      const secret = process.env.VALQENIX_WEBHOOK_SECRET || '';
      if (!pg.verifyValqenixWebhook(raw, sig, ts, secret)) { res.writeHead(401); return res.end('invalid signature'); }
      let body = {}; try { body = JSON.parse(raw); } catch (_) {}
      const d = body.data || body;
      const reference = d.reference || d.id;
      const status = String(d.status || '').toLowerCase();
      const paid = evt.includes('paid') || evt.includes('settled') || status === 'paid' || status === 'settled';
      if (reference && paid) {
        try {
          const co = await checkoutService.markPaidByReference(reference);
          if (!co.found) await depositService.creditByReference(reference);
        } catch (e) { console.error('[web] valqenix webhook handle error:', e); }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }

    // ---- API ----
    if (p.startsWith('/api/')) {
      // Public
      if (p === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, { botUsername: BOT_USERNAME, publicUrl: process.env.WEB_PUBLIC_URL || '', adminContact: process.env.ADMIN_WA || process.env.ADMIN_CONTACT || process.env.ADMIN_USERNAME || '' });
      }
      if (p === '/api/auth/telegram' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body) return sendJson(res, 400, { ok: false, error: 'Body tidak valid.' });
        if (!auth.verifyTelegramLogin(body, BOT_TOKEN)) return sendJson(res, 401, { ok: false, error: 'Verifikasi Telegram gagal.' });
        await getUser(String(body.id));
        setSessionCookie(res, String(body.id));
        return sendJson(res, 200, { ok: true, user: { id: String(body.id), first_name: body.first_name || '', username: body.username || '' } });
      }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        clearSessionCookie(res);
        return sendJson(res, 200, { ok: true });
      }
      // Daftar akun web: generate username + password acak, langsung login.
      if (p === '/api/auth/register' && req.method === 'POST') {
        const r = await accountService.register();
        if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error || 'Gagal membuat akun.' });
        setSessionCookie(res, String(r.userId));
        return sendJson(res, 200, { ok: true, username: r.username, password: r.password });
      }
      // Login akun web dengan username + password.
      if (p === '/api/auth/login' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body) return sendJson(res, 400, { ok: false, error: 'Body tidak valid.' });
        const r = await accountService.login(body.username, body.password);
        if (!r.ok) return sendJson(res, 401, { ok: false, error: r.error || 'Login gagal.' });
        setSessionCookie(res, String(r.userId));
        return sendJson(res, 200, { ok: true, username: r.username });
      }

      // Login OPSIONAL: uid boleh null (tamu). Endpoint RDP/checkout bisa dipakai tamu;
      // pembayaran otomatis pakai saldo (bila login & cukup) atau QRIS (tamu/saldo kurang).
      const uid = sessionUser(req);

      // ---- Endpoint yang boleh diakses tamu ----
      if (p === '/api/rdp/products' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, products: await rdpService.listProducts() });
      }
      if (p === '/api/rdp/os' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, osList: rdpService.osOptions() });
      }
      if (p === '/api/rdp/install-cost' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, installCost: await rdpService.getInstallCost() });
      }
      // Install RDP via API cloud sendiri: validasi token + daftar region/size.
      if (p === '/api/rdp/api-regions' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body) return sendJson(res, 400, { ok: false, error: 'Body tidak valid.' });
        return sendJson(res, 200, await rdpService.listApiRegions(body.apiToken));
      }
      if (p === '/api/rdp/api-sizes' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body) return sendJson(res, 400, { ok: false, error: 'Body tidak valid.' });
        return sendJson(res, 200, await rdpService.listApiSizes(body.apiToken, body.regionSlug));
      }
      if (p === '/api/rdp/options' && req.method === 'GET') {
        const ram = parsed.searchParams.get('ram');
        const core = parsed.searchParams.get('core');
        const duration = parsed.searchParams.get('duration');
        return sendJson(res, 200, await rdpService.getOrderOptions(ram, core, duration));
      }
      // Endpoint order/install GENERIK untuk semua layanan.
      // body = { kind: 'rdp_order'|'vps_order'|'cloud9_order'|'fastpanel_order'|'rdp_install'|'cloud9_install'|'fastpanel_install', params:{...} }
      if (p === '/api/order' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !body.kind) return sendJson(res, 400, { ok: false, error: 'Body tidak valid.' });
        return sendJson(res, 200, await checkoutService.start(uid, body.kind, body.params || {}));
      }
      // Katalog per layanan.
      if (p === '/api/vps/products' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, products: await vpsService.listProducts() });
      }
      if (p === '/api/vps/options' && req.method === 'GET') {
        return sendJson(res, 200, await vpsService.getOrderOptions(parsed.searchParams.get('ram'), parsed.searchParams.get('core'), parsed.searchParams.get('duration')));
      }
      if (p === '/api/cloud9/products' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, products: await cloud9Service.listProducts() });
      }
      if (p === '/api/fastpanel/products' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, products: await fastpanelService.listProducts() });
      }
      if (p === '/api/checkout/status' && req.method === 'GET') {
        const trx = parsed.searchParams.get('trx');
        if (!trx) return sendJson(res, 400, { ok: false, error: 'trx wajib.' });
        return sendJson(res, 200, { ok: true, ...(await checkoutService.status(trx)) });
      }
      if (p.startsWith('/api/job/') && req.method === 'GET') {
        const jobId = p.split('/')[3];
        const job = rdpService.getJob(jobId);
        if (!job) return sendJson(res, 404, { ok: false, error: 'Job tidak ditemukan.' });
        // Jangan kirim log detail instalasi ke browser (bisa memuat link unduhan/perintah internal).
        const { logs, ...safeJob } = job;
        return sendJson(res, 200, { ok: true, job: safeJob });
      }

      // ---- Endpoint yang WAJIB login ----
      if (!uid) return sendJson(res, 401, { ok: false, error: 'Belum login.' });

      if (p === '/api/me' && req.method === 'GET') {
        const bal = await getBalance(uid);
        const username = await accountService.getUsername(uid);
        return sendJson(res, 200, { ok: true, telegramId: uid, username: username || null, isWebAccount: accountService.isWebAccount(uid), balance: typeof bal === 'string' ? bal : Number(bal), isAdmin: isAdmin(uid) });
      }
      // ---- Kelola VPS/RDP milik sendiri ("VPS/RDP Saya") ----
      if (p === '/api/servers' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, servers: await manageService.listServers(uid) });
      }
      if (p === '/api/server/power' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !body.id) return sendJson(res, 400, { ok: false, error: 'Body tidak valid.' });
        return sendJson(res, 200, await manageService.powerServer(uid, body.id, body.action));
      }
      if (p === '/api/server/delete' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !body.id) return sendJson(res, 400, { ok: false, error: 'Body tidak valid.' });
        return sendJson(res, 200, await manageService.deleteServer(uid, body.id));
      }
      // Rebuild: tanpa biaya, masa aktif tetap, tipe dipertahankan (RDP/VPS/Cloud9/Fastpanel).
      if (p === '/api/server/rebuild' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || !body.id) return sendJson(res, 400, { ok: false, error: 'Body tidak valid.' });
        return sendJson(res, 200, await manageService.rebuildServer(uid, body.id, { osVersion: body.osVersion, customPassword: body.customPassword }));
      }
      if (p === '/api/rdp/mine' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, servers: await rdpService.listMyRdp(uid) });
      }
      if (p === '/api/tx' && req.method === 'GET') {
        let rows = [];
        try { rows = await db.all('SELECT amount, type, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 20', [uid]); } catch (_) {}
        return sendJson(res, 200, { ok: true, transactions: rows });
      }
      if (p === '/api/deposit' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body) return sendJson(res, 400, { ok: false, error: 'Body tidak valid.' });
        return sendJson(res, 200, await depositService.createDeposit(uid, body.amount));
      }
      if (p === '/api/deposit/status' && req.method === 'GET') {
        const trx = parsed.searchParams.get('trx');
        const amount = parsed.searchParams.get('amount');
        if (!trx) return sendJson(res, 400, { ok: false, error: 'trx wajib.' });
        return sendJson(res, 200, { ok: true, ...(await depositService.checkAndCredit(uid, trx, amount)) });
      }

      return sendJson(res, 404, { ok: false, error: 'Endpoint tidak ditemukan.' });
    }

    // ---- Static ----
    if (req.method === 'GET') return serveStatic(res, p);
    res.writeHead(405); res.end('Method not allowed');
  } catch (e) {
    console.error('[web] request error:', e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Kesalahan server.' });
  }
});

server.listen(PORT, () => {
  console.log(`🌐 KOBONG CLOUD SERVER web app berjalan di http://localhost:${PORT}`);
});

// Anti-crash: jangan biarkan 1 error tak tertangani mematikan seluruh web server
// (penyebab umum error 521 Cloudflare = proses mati). Log saja, proses tetap hidup.
process.on('uncaughtException', (err) => {
  console.error('[web] uncaughtException:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('[web] unhandledRejection:', reason && (reason.stack || reason.message || reason));
});
// Kalau port sudah dipakai / gagal listen, beri pesan jelas.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[web] Port ${PORT} sudah dipakai proses lain. Hentikan proses itu atau ganti WEB_PORT.`);
  } else {
    console.error('[web] server error:', err && (err.stack || err.message || err));
  }
});
