// ===== KOBONG CLOUD SERVER — dashboard SPA =====
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const fmtRp = (n) => (typeof n === 'string' ? n : 'Rp ' + Number(n || 0).toLocaleString('id-ID'));

// Login OPSIONAL: api() tidak me-redirect saat 401 (tamu diperbolehkan).
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let json = {};
  try { json = await r.json(); } catch (_) {}
  if (json && typeof json === 'object') json.__status = r.status;
  return json;
}
function notice(el, type, msg) { el.innerHTML = msg ? `<div class="notice ${type}">${msg}</div>` : ''; }
function copyBtn(text) { return `<span class="copy" onclick="navigator.clipboard.writeText('${String(text).replace(/'/g, "\\'")}')">salin</span>`; }
const FINAL = ['ready', 'failed', 'installing_timeout'];

let ME = null; // null = tamu (belum login)

function applyAuthUI() {
  const logged = !!ME;
  const pill = $('#balance-pill');
  const authBtn = $('#auth-btn');
  if (pill) pill.classList.toggle('hidden', !logged);
  if (logged && $('#balance')) $('#balance').textContent = fmtRp(ME.balance);
  if (authBtn) { authBtn.textContent = logged ? 'Keluar' : 'Masuk'; authBtn.dataset.act = logged ? 'logout' : 'login'; }
  if ($('#d-balance')) $('#d-balance').textContent = logged ? fmtRp(ME.balance) : '—';
  if ($('#d-tid')) $('#d-tid').textContent = logged ? ME.telegramId : 'Tamu';
  // Elemen khusus akun disembunyikan untuk tamu.
  const depTab = document.querySelector('.tab[data-tab="deposit"]');
  if (depTab) depTab.classList.toggle('hidden', !logged);
  const stats = $('#stats-grid'); if (stats) stats.classList.toggle('hidden', !logged);
  const gn = $('#guest-note'); if (gn) gn.classList.toggle('hidden', logged);
  const mineCard = $('#my-rdp') ? $('#my-rdp').closest('.card') : null; if (mineCard) mineCard.classList.toggle('hidden', !logged);
  const txCard = $('#tx-list') ? $('#tx-list').closest('.card') : null; if (txCard) txCard.classList.toggle('hidden', !logged);
}
async function loadMe() {
  const me = await api('/api/me');
  ME = (me && me.ok) ? me : null;
  applyAuthUI();
  return ME;
}
async function refreshBalance() { await loadMe(); }

// ---------- tabs ----------
function activateTab(name) {
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tabpane').forEach((p) => p.classList.add('hidden'));
  const pane = $('#tab-' + name);
  if (pane) pane.classList.remove('hidden');
}
$$('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));

$('#auth-btn').addEventListener('click', async (e) => {
  if (e.currentTarget.dataset.act === 'logout') {
    await fetch('/api/auth/logout', { method: 'POST' });
  }
  window.location.href = '/'; // login ada di landing (Telegram Login Widget)
});

// ---------- dashboard ----------
async function loadMine() {
  const box = $('#my-rdp');
  try {
    const res = await api('/api/rdp/mine');
    if (!res || !res.ok) return; // tamu
    const servers = res.servers || [];
    if ($('#d-rdpcount')) $('#d-rdpcount').textContent = servers.length;
    if (!servers.length) { box.innerHTML = '<span class="muted">Belum ada RDP. Buat lewat tab Order RDP.</span>'; return; }
    box.innerHTML = servers.map((s) => `
      <div class="server-row">
        <div>
          <div class="mono">🖥️ ${s.server} ${copyBtn(s.ip)}</div>
          <div class="muted" style="font-size:12px">${s.os || 'Windows'} · ${s.region} · user: administrator</div>
        </div>
        <div class="mono">${s.password ? '🔑 ' + s.password + copyBtn(s.password) : ''}</div>
      </div>`).join('');
  } catch (_) { box.innerHTML = '<span class="muted">Gagal memuat.</span>'; }
}
async function loadTx() {
  const box = $('#tx-list');
  try {
    const res = await api('/api/tx');
    if (!res || !res.ok) return; // tamu
    const transactions = res.transactions || [];
    if (!transactions.length) { box.innerHTML = '<span class="muted">Belum ada transaksi.</span>'; return; }
    box.innerHTML = transactions.map((t) => {
      const amt = Number(t.amount);
      const pos = amt >= 0;
      return `<div class="server-row"><div><span class="tag ${pos ? 'ok' : 'err'}">${t.type}</span> <span class="muted" style="font-size:12px">${t.created_at || ''}</span></div><div class="mono" style="color:${pos ? 'var(--ok)' : 'var(--err)'}">${pos ? '+' : ''}${fmtRp(amt)}</div></div>`;
    }).join('');
  } catch (_) { box.innerHTML = '<span class="muted">Gagal memuat.</span>'; }
}

// ---------- job registry (persist across refresh via localStorage) ----------
const LS_JOBS = 'kobong_jobs';
const jobCache = {};
let pollTimer = null;
function lsGetJobs() { try { return JSON.parse(localStorage.getItem(LS_JOBS) || '[]'); } catch (_) { return []; } }
function lsSetJobs(a) { localStorage.setItem(LS_JOBS, JSON.stringify(a.slice(-6))); }
function trackJob(id) { const a = lsGetJobs(); if (!a.includes(id)) { a.push(id); lsSetJobs(a); } ensurePolling(); renderActiveJobs(); }
function untrackJob(id) { lsSetJobs(lsGetJobs().filter((x) => x !== id)); delete jobCache[id]; renderActiveJobs(); }
window.dismissJob = untrackJob;

function ensurePolling() { if (pollTimer) return; pollTimer = setInterval(pollAll, 4000); pollAll(); }
async function pollAll() {
  const ids = lsGetJobs();
  if (!ids.length) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } renderActiveJobs(); return; }
  let anyActive = false;
  for (const id of ids) {
    try {
      const { ok, job } = await api('/api/job/' + id);
      if (ok && job) { jobCache[id] = job; if (!FINAL.includes(job.status)) anyActive = true; }
      else { lsSetJobs(lsGetJobs().filter((x) => x !== id)); delete jobCache[id]; } // expired di server
    } catch (_) {}
  }
  renderActiveJobs();
  if (!anyActive) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } refreshBalance(); loadMine(); }
}
function jobCardHtml(job) {
  const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const spinning = !FINAL.includes(job.status);
  const kind = job.kind === 'install' ? 'Install RDP (VPS sendiri)' : 'Order RDP';
  const tag = job.status === 'ready' ? '<span class="tag ok">SELESAI</span>'
    : (job.status === 'failed' ? '<span class="tag err">GAGAL</span>'
    : (job.status === 'installing_timeout' ? '<span class="tag warn">CEK MANUAL</span>' : '<span class="tag warn">PROSES</span>'));
  let h = `<div class="jobcard">
    <div class="row-flex" style="justify-content:space-between">
      <div><b>${kind}</b> ${tag}</div>
      <div>${spinning ? '<span class="spinner"></span>' : ''} <span class="copy" onclick="dismissJob('${job.id}')">tutup</span></div>
    </div>
    <div class="pbar"><div class="pbar-fill" style="width:${pct}%"></div></div>
    <div class="muted" style="font-size:13px">${pct}% · ${job.message || ''}</div>`;
  if (job.server && (job.status === 'ready' || job.status === 'installing_timeout')) {
    const s = job.server;
    h += `<div style="margin-top:10px">
      <div class="server-row"><span class="muted">Server</span><span class="mono">${s.ip}:${s.port} ${copyBtn(s.ip)}</span></div>
      <div class="server-row"><span class="muted">Username</span><span class="mono">${s.username}</span></div>
      <div class="server-row"><span class="muted">Password</span><span class="mono">${s.password} ${copyBtn(s.password)}</span></div>
      ${s.os ? `<div class="server-row"><span class="muted">Windows</span><span class="mono">${s.os}</span></div>` : ''}
    </div>`;
  }
  if (job.logs && job.logs.length) {
    h += `<div class="joblog">${job.logs.map((l) => String(l).replace(/</g, '&lt;')).join('\n')}</div>`;
  }
  h += `</div>`;
  return h;
}
function renderActiveJobs() {
  const ids = lsGetJobs();
  const card = $('#active-jobs-card');
  const box = $('#active-jobs');
  if (!box) return;
  if (!ids.length) { if (card) card.classList.add('hidden'); return; }
  if (card) card.classList.remove('hidden');
  box.innerHTML = ids.map((id) => (jobCache[id] ? jobCardHtml(jobCache[id]) : '')).join('') || '<span class="muted">Memuat…</span>';
}

// ---------- checkout (bayar via saldo atau QRIS) ----------
const LS_CO = 'kobong_checkouts';
let coTimer = null;
let curModalTrx = null;
function lsGetCO() { try { return JSON.parse(localStorage.getItem(LS_CO) || '[]'); } catch (_) { return []; } }
function lsSetCO(a) { localStorage.setItem(LS_CO, JSON.stringify(a.slice(-6))); }
function addCO(trx) { const a = lsGetCO(); if (!a.includes(trx)) { a.push(trx); lsSetCO(a); } ensureCOPolling(); }
function delCO(trx) { lsSetCO(lsGetCO().filter((x) => x !== trx)); }
function ensureCOPolling() { if (coTimer) return; coTimer = setInterval(pollCOs, 6000); pollCOs(); }
async function pollCOs() {
  const ids = lsGetCO();
  if (!ids.length) { if (coTimer) { clearInterval(coTimer); coTimer = null; } return; }
  for (const trx of ids) {
    try {
      const st = await api('/api/checkout/status?trx=' + encodeURIComponent(trx));
      if (st.status === 'paid' && st.jobId) {
        delCO(trx); trackJob(st.jobId); refreshBalance();
        if (curModalTrx === trx) { $('#qr-status').innerHTML = '<div class="notice ok">✅ Dibayar! Proses dimulai.</div>'; setTimeout(() => { closeQrModal(); activateTab('dashboard'); }, 1200); }
      } else if (st.status === 'expired') {
        delCO(trx); if (curModalTrx === trx) $('#qr-status').innerHTML = '<div class="notice err">❌ QRIS kadaluarsa. Ulangi order.</div>';
      } else if (st.status === 'provision_failed') {
        delCO(trx); if (curModalTrx === trx) $('#qr-status').innerHTML = '<div class="notice err">❌ ' + (st.error || 'Gagal memproses setelah bayar. Hubungi admin.') + '</div>';
      }
    } catch (_) {}
  }
}
function closeQrModal() { $('#qr-modal').classList.add('hidden'); curModalTrx = null; }
function openQrModal(res) {
  curModalTrx = res.transactionId;
  addCO(res.transactionId);
  $('#qr-amount').textContent = 'Bayar sebesar ' + fmtRp(res.amount) + ' — scan QRIS di bawah.';
  $('#qr-holder').innerHTML = res.qrImage ? `<div class="qr"><img src="${res.qrImage}" alt="QRIS"/></div>` : `<span class="muted">QR: ${res.qrString || '-'}</span>`;
  $('#qr-status').innerHTML = '<div class="notice info"><span class="spinner"></span> Menunggu pembayaran…</div>';
  $('#qr-modal').classList.remove('hidden');
}
$('#qr-close').addEventListener('click', closeQrModal);
// Tangani hasil order/install: bayar saldo (langsung jalan) atau QRIS (tampilkan modal).
function handleCheckoutResult(res, msgEl) {
  if (!res || !res.ok) { notice(msgEl, 'err', (res && res.error) || 'Gagal.'); return false; }
  if (res.mode === 'balance') {
    notice(msgEl, 'ok', '✅ Dibayar pakai saldo. Progres di Dashboard → “Proses Berjalan”.');
    trackJob(res.jobId); activateTab('dashboard'); refreshBalance();
    return true;
  }
  if (res.mode === 'qris') {
    notice(msgEl, 'ok', 'QRIS dibuat. Setelah dibayar, proses jalan otomatis (lihat Dashboard).');
    openQrModal(res);
    return true;
  }
  notice(msgEl, 'err', 'Respons tidak dikenali.');
  return false;
}

// ---------- order ----------
let PRODUCTS = [];
let selPkg = null;
const DUR = [{ v: 1, k: 'daily', label: 'Harian (1 hari)' }, { v: 7, k: 'weekly', label: 'Mingguan (7 hari)' }, { v: 30, k: 'monthly', label: 'Bulanan (30 hari)' }];

async function loadProducts() {
  const grid = $('#pkg-grid');
  try {
    const { products } = await api('/api/rdp/products');
    PRODUCTS = products;
    if (!products.length) { grid.innerHTML = '<span class="muted">Belum ada paket RDP. Hubungi admin.</span>'; return; }
    grid.innerHTML = products.map((p, i) => {
      const prices = [p.price_daily, p.price_weekly, p.price_monthly].filter((x) => x != null);
      const minP = prices.length ? Math.min(...prices) : 0;
      const slots = Number(p.slot_daily) + Number(p.slot_weekly) + Number(p.slot_monthly);
      return `<div class="pkg" data-i="${i}"><div class="spec">${p.ram}GB RAM</div><div class="muted">${p.core} vCPU</div><div class="price">mulai ${fmtRp(minP)}</div><div class="slot">${slots} slot tersedia</div></div>`;
    }).join('');
    $$('.pkg', grid).forEach((el) => el.addEventListener('click', () => selectPkg(Number(el.dataset.i), el)));
  } catch (_) { grid.innerHTML = '<span class="muted">Gagal memuat paket.</span>'; }
}
function selectPkg(i, el) {
  selPkg = PRODUCTS[i];
  $$('.pkg').forEach((x) => x.classList.remove('sel'));
  el.classList.add('sel');
  // durasi tersedia
  const dsel = $('#o-duration');
  dsel.innerHTML = '';
  DUR.forEach((d) => {
    const price = selPkg['price_' + d.k];
    const slot = Number(selPkg['slot_' + d.k] || 0);
    if (price != null && slot > 0) {
      const o = document.createElement('option');
      o.value = d.v; o.textContent = `${d.label} — ${fmtRp(price)} (${slot} slot)`;
      dsel.appendChild(o);
    }
  });
  if (!dsel.options.length) { notice($('#order-msg'), 'err', 'Paket ini tidak punya slot aktif.'); return; }
  $('#order-step-detail').classList.remove('hidden');
  loadOptions();
}
async function loadOptions() {
  if (!selPkg) return;
  const dur = $('#o-duration').value;
  notice($('#order-msg'), '', '');
  const res = await api(`/api/rdp/options?ram=${selPkg.ram}&core=${selPkg.core}&duration=${dur}`);
  if (!res.ok) { notice($('#order-msg'), 'err', res.error || 'Gagal memuat opsi.'); return; }
  $('#o-submit').dataset.productId = res.productId;
  const rsel = $('#o-region');
  rsel.innerHTML = res.regions.length ? res.regions.map((r) => `<option value="${r.slug}">${r.slug} — ${r.name}</option>`).join('') : '<option value="">(tidak ada region)</option>';
  const osel = $('#o-os');
  osel.innerHTML = res.osList.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
  $('#o-price').textContent = `Total biaya: ${fmtRp(res.price)} (VPS + install RDP)`;
}
$('#o-duration').addEventListener('change', loadOptions);
$('#o-passmode').addEventListener('change', (e) => $('#o-custompass-wrap').classList.toggle('hidden', e.target.value !== 'custom'));
$('#o-reset').addEventListener('click', () => { selPkg = null; $$('.pkg').forEach((x) => x.classList.remove('sel')); $('#order-step-detail').classList.add('hidden'); $('#order-progress').classList.add('hidden'); notice($('#order-msg'), '', ''); });
$('#o-submit').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const productId = Number(btn.dataset.productId);
  const region = $('#o-region').value;
  const osId = Number($('#o-os').value);
  const durationDays = Number($('#o-duration').value);
  const passmode = $('#o-passmode').value;
  const customPassword = passmode === 'custom' ? $('#o-custompass').value : undefined;
  if (!productId || !region) { notice($('#order-msg'), 'err', 'Lengkapi pilihan dulu.'); return; }
  btn.disabled = true; notice($('#order-msg'), 'info', '<span class="spinner"></span> Mengirim order…');
  try {
    const res = await api('/api/rdp/order', { method: 'POST', body: JSON.stringify({ productId, regionSlug: region, osId, durationDays, customPassword }) });
    handleCheckoutResult(res, $('#order-msg'));
  } catch (_) { notice($('#order-msg'), 'err', 'Terjadi kesalahan.'); }
  btn.disabled = false;
});

// ---------- install ----------
async function loadOsList() {
  const { osList } = await api('/api/rdp/os');
  const opts = osList.map((o) => `<option value="${o.version}">${o.name}</option>`).join('');
  $('#i-os').innerHTML = opts;
  try {
    const c = await api('/api/rdp/install-cost');
    const cost = c && c.ok ? c.installCost : null;
    $('#i-info').textContent = (cost ? `Biaya jasa install: ${fmtRp(cost)}. ` : '') + 'Dibayar via saldo (jika login & cukup) atau QRIS. VPS wajib fresh install Ubuntu.';
  } catch (_) {
    $('#i-info').textContent = 'Biaya jasa install dibayar via saldo atau QRIS. VPS wajib fresh install Ubuntu.';
  }
}
$('#i-submit').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ip = $('#i-ip').value.trim();
  const sshUser = $('#i-user').value.trim() || 'root';
  const sshPassword = $('#i-pass').value;
  const osVersion = $('#i-os').value;
  const rdpPassword = $('#i-rdppass').value.trim() || undefined;
  if (!ip || !sshPassword) { notice($('#install-msg'), 'err', 'IP & password SSH wajib diisi.'); return; }
  btn.disabled = true; notice($('#install-msg'), 'info', '<span class="spinner"></span> Memulai…');
  try {
    const res = await api('/api/rdp/install', { method: 'POST', body: JSON.stringify({ ip, sshUser, sshPassword, osVersion, rdpPassword }) });
    handleCheckoutResult(res, $('#install-msg'));
  } catch (_) { notice($('#install-msg'), 'err', 'Terjadi kesalahan.'); }
  btn.disabled = false;
});

// ---------- deposit ----------
$$('.dep-quick').forEach((b) => b.addEventListener('click', () => { $('#dep-amount').value = b.dataset.v; }));
let depTimer = null;
$('#dep-submit').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const amount = Number($('#dep-amount').value);
  if (!amount || amount < 1000) { notice($('#dep-msg'), 'err', 'Minimal Rp 1.000.'); return; }
  btn.disabled = true; notice($('#dep-msg'), 'info', '<span class="spinner"></span> Membuat QRIS…');
  try {
    const res = await api('/api/deposit', { method: 'POST', body: JSON.stringify({ amount }) });
    if (!res.ok) { notice($('#dep-msg'), 'err', res.error || 'Gagal membuat QRIS.'); btn.disabled = false; return; }
    notice($('#dep-msg'), 'ok', 'QRIS dibuat. Scan & bayar sebesar ' + fmtRp(res.amount) + '.');
    $('#dep-qr-sub').textContent = 'Scan dengan aplikasi e-wallet / m-banking (QRIS).';
    $('#dep-qr-holder').innerHTML = res.qrImage ? `<div class="qr"><img src="${res.qrImage}" alt="QRIS"/></div>` : '<span class="muted">QR string: ' + (res.qrString || '-') + '</span>';
    $('#dep-status').innerHTML = '<div class="notice info"><span class="spinner"></span> Menunggu pembayaran…</div>';
    if (depTimer) clearInterval(depTimer);
    depTimer = setInterval(async () => {
      try {
        const st = await api(`/api/deposit/status?trx=${encodeURIComponent(res.transactionId)}&amount=${res.amount}`);
        if (st.status === 'success') {
          clearInterval(depTimer);
          $('#dep-status').innerHTML = '<div class="notice ok">✅ Pembayaran diterima! Saldo sudah ditambahkan.</div>';
          $('#dep-qr-holder').innerHTML = '';
          refreshBalance(); loadTx();
        }
      } catch (_) {}
    }, 6000);
  } catch (_) { notice($('#dep-msg'), 'err', 'Terjadi kesalahan.'); }
  btn.disabled = false;
});

// ---------- init ----------
(async function () {
  try {
    const me = await loadMe();          // login opsional (tamu -> me null)
    await loadProducts();
    await loadOsList();
    if (me) { await loadMine(); await loadTx(); } // fitur akun hanya untuk yang login
    // Resume proses & pembayaran yang sedang berjalan (persist saat refresh).
    renderActiveJobs();
    if (lsGetJobs().length) ensurePolling();
    if (lsGetCO().length) ensureCOPolling();
  } catch (_) {}
})();
