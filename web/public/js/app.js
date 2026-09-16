// ===== KOBONG CLOUD SERVER — dashboard SPA =====
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const fmtRp = (n) => (typeof n === 'string' ? n : 'Rp ' + Number(n || 0).toLocaleString('id-ID'));

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (r.status === 401) { window.location.href = '/'; throw new Error('unauthorized'); }
  return r.json();
}
function notice(el, type, msg) { el.innerHTML = msg ? `<div class="notice ${type}">${msg}</div>` : ''; }
function copyBtn(text) { return `<span class="copy" onclick="navigator.clipboard.writeText('${String(text).replace(/'/g, "\\'")}')">salin</span>`; }
const FINAL = ['ready', 'failed', 'installing_timeout'];

let ME = null;

async function refreshBalance() {
  const me = await api('/api/me');
  ME = me;
  const b = fmtRp(me.balance);
  $('#balance').textContent = b;
  if ($('#d-balance')) $('#d-balance').textContent = b;
  if ($('#d-tid')) $('#d-tid').textContent = me.telegramId;
}

// ---------- tabs ----------
function activateTab(name) {
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tabpane').forEach((p) => p.classList.add('hidden'));
  const pane = $('#tab-' + name);
  if (pane) pane.classList.remove('hidden');
}
$$('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));

$('#logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

// ---------- dashboard ----------
async function loadMine() {
  const box = $('#my-rdp');
  try {
    const { servers } = await api('/api/rdp/mine');
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
    const { transactions } = await api('/api/tx');
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
    if (!res.ok) { notice($('#order-msg'), 'err', res.error || 'Gagal order.'); btn.disabled = false; return; }
    notice($('#order-msg'), 'ok', '✅ Order diterima! Progres instalasi tampil di Dashboard → “Proses Berjalan” (tetap ada walau halaman di-refresh).');
    trackJob(res.jobId);
    activateTab('dashboard');
    refreshBalance();
  } catch (_) { notice($('#order-msg'), 'err', 'Terjadi kesalahan.'); }
  btn.disabled = false;
});

// ---------- install ----------
async function loadOsList() {
  const { osList } = await api('/api/rdp/os');
  const opts = osList.map((o) => `<option value="${o.version}">${o.name}</option>`).join('');
  $('#i-os').innerHTML = opts;
  $('#i-info').textContent = 'Biaya install akan dipotong dari saldo saat proses dimulai. VPS wajib fresh install Ubuntu.';
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
    if (!res.ok) { notice($('#install-msg'), 'err', res.error || 'Gagal.'); btn.disabled = false; return; }
    notice($('#install-msg'), 'ok', '✅ Instalasi dimulai! Progres tampil di Dashboard → “Proses Berjalan” (tetap ada walau halaman di-refresh).');
    trackJob(res.jobId);
    activateTab('dashboard');
    refreshBalance();
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
    await refreshBalance();
    await loadMine();
    await loadTx();
    await loadProducts();
    await loadOsList();
    // Resume proses yang sedang berjalan (persist saat refresh).
    renderActiveJobs();
    if (lsGetJobs().length) ensurePolling();
  } catch (_) {}
})();
