// ===== KOBONG CLOUD SERVER — dashboard SPA (multi-layanan) =====
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const fmtRp = (n) => (typeof n === 'string' ? n : 'Rp ' + Number(n || 0).toLocaleString('id-ID'));
const FINAL = ['ready', 'failed', 'installing_timeout'];

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let json = {};
  try { json = await r.json(); } catch (_) {}
  if (json && typeof json === 'object') json.__status = r.status;
  return json;
}
function notice(el, type, msg) { if (el) el.innerHTML = msg ? `<div class="notice ${type}">${msg}</div>` : ''; }
function copyBtn(t) { return `<span class="copy" onclick="navigator.clipboard.writeText('${String(t).replace(/'/g, "\\'")}')">salin</span>`; }

// ---------- auth ----------
let ME = null;
function applyAuthUI() {
  const logged = !!ME;
  const badge = $('#guest-badge'); if (badge) badge.classList.toggle('hidden', logged);
  const pill = $('#balance-pill'); if (pill) pill.classList.toggle('hidden', !logged);
  if (logged && $('#balance')) $('#balance').textContent = fmtRp(ME.balance);
  const authBtn = $('#auth-btn'); if (authBtn) { authBtn.textContent = logged ? 'Keluar' : 'Masuk'; authBtn.dataset.act = logged ? 'logout' : 'login'; }
  if ($('#d-balance')) $('#d-balance').textContent = logged ? fmtRp(ME.balance) : '—';
  if ($('#d-tid')) $('#d-tid').textContent = logged ? ME.telegramId : 'Tamu';
  const depNav = document.querySelector('.navitem[data-view="deposit"]'); if (depNav) depNav.classList.toggle('hidden', !logged);
}
async function loadMe() { const me = await api('/api/me'); ME = (me && me.ok) ? me : null; applyAuthUI(); return ME; }
async function refreshBalance() { await loadMe(); }

// ---------- navigation (sidebar + views) ----------
const VIEW_TITLES = { dashboard: 'DASHBOARD UTAMA', order: 'ORDER LAYANAN', install: 'JASA INSTALL', deposit: 'DEPOSIT SALDO', status: 'STATUS SERVER', history: 'RIWAYAT & LACAK' };
function closeSidebar() { const s = $('#sidebar'); if (s) s.classList.remove('open'); const b = $('#backdrop'); if (b) b.classList.remove('show'); }
function openSidebar() { const s = $('#sidebar'); if (s) s.classList.add('open'); const b = $('#backdrop'); if (b) b.classList.add('show'); }
function showView(name) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  const v = $('#view-' + name); if (v) v.classList.add('active');
  $$('.navitem[data-view]').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  const t = $('#topbar-title'); if (t && VIEW_TITLES[name]) t.textContent = VIEW_TITLES[name];
  closeSidebar();
  window.scrollTo(0, 0);
}
const activateTab = showView; // kompatibilitas kode lama
function selectSub(group, name) {
  $$(`.subtab[data-sub="${group}"]`).forEach((x) => x.classList.toggle('active', x.dataset.name === name));
  ['rdp', 'vps', 'cloud9', 'fastpanel'].forEach((n) => { const el = $('#' + group + '-' + n); if (el) el.classList.add('hidden'); });
  const show = $('#' + group + '-' + name); if (show) show.classList.remove('hidden');
}
function openService(group, name) { showView(group); selectSub(group, name); }

$$('.navitem[data-view]').forEach((n) => n.addEventListener('click', () => showView(n.dataset.view)));
$$('.back-link[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$$('.svc-card[data-open]').forEach((c) => c.addEventListener('click', () => { const parts = String(c.dataset.open).split(':'); openService(parts[0], parts[1]); }));
$$('.subtab').forEach((t) => t.addEventListener('click', () => selectSub(t.dataset.sub, t.dataset.name)));
if ($('#hamburger')) $('#hamburger').addEventListener('click', openSidebar);
if ($('#backdrop')) $('#backdrop').addEventListener('click', closeSidebar);

$('#auth-btn').addEventListener('click', async (e) => {
  if (e.currentTarget.dataset.act === 'logout') await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

// Link "Hubungi Admin" dari /api/config
(async function () {
  try {
    const cfg = await api('/api/config');
    const c = cfg && cfg.adminContact ? String(cfg.adminContact) : '';
    const el = $('#wa-link'); if (!el || !c) return;
    let href = '#';
    if (/^https?:\/\//i.test(c)) href = c;
    else if (c.startsWith('@')) href = 'https://t.me/' + c.slice(1);
    else if (/^\d[\d\s+-]*$/.test(c)) href = 'https://wa.me/' + c.replace(/[^\d]/g, '');
    else href = 'https://t.me/' + c;
    el.href = href;
  } catch (_) {}
})();

// ---------- job registry (persist across refresh) ----------
const LS_JOBS = 'kobong_jobs';
const jobCache = {};
let pollTimer = null;
function lsGetJobs() { try { return JSON.parse(localStorage.getItem(LS_JOBS) || '[]'); } catch (_) { return []; } }
function lsSetJobs(a) { localStorage.setItem(LS_JOBS, JSON.stringify(a.slice(-8))); }
function trackJob(id) { const a = lsGetJobs(); if (!a.includes(id)) { a.push(id); lsSetJobs(a); } ensurePolling(); renderActiveJobs(); }
window.dismissJob = (id) => { lsSetJobs(lsGetJobs().filter((x) => x !== id)); delete jobCache[id]; renderActiveJobs(); };
function ensurePolling() { if (pollTimer) return; pollTimer = setInterval(pollAll, 4000); pollAll(); }
async function pollAll() {
  const ids = lsGetJobs();
  if (!ids.length) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } renderActiveJobs(); return; }
  let anyActive = false;
  for (const id of ids) {
    try {
      const { ok, job } = await api('/api/job/' + id);
      if (ok && job) { jobCache[id] = job; if (!FINAL.includes(job.status)) anyActive = true; }
      else { lsSetJobs(lsGetJobs().filter((x) => x !== id)); delete jobCache[id]; }
    } catch (_) {}
  }
  renderActiveJobs();
  if (!anyActive) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } refreshBalance(); loadMine(); }
}
function kindLabel(kind) {
  return ({ order: 'Order RDP', vps: 'Order VPS', cloud9: 'Order Cloud9', fastpanel: 'Order Fastpanel', install: 'Install RDP', cloud9_install: 'Install Cloud9', fastpanel_install: 'Install Fastpanel' })[kind] || 'Proses';
}
function jobCardHtml(job) {
  const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const spinning = !FINAL.includes(job.status);
  const tag = job.status === 'ready' ? '<span class="tag ok">SELESAI</span>' : (job.status === 'failed' ? '<span class="tag err">GAGAL</span>' : (job.status === 'installing_timeout' ? '<span class="tag warn">CEK MANUAL</span>' : '<span class="tag warn">PROSES</span>'));
  let h = `<div class="jobcard"><div class="row-flex" style="justify-content:space-between"><div><b>${kindLabel(job.kind)}</b> ${tag}</div><div>${spinning ? '<span class="spinner"></span>' : ''} <span class="copy" onclick="dismissJob('${job.id}')">tutup</span></div></div>`;
  h += `<div class="pbar"><div class="pbar-fill" style="width:${pct}%"></div></div><div class="muted" style="font-size:13px">${pct}% · ${job.message || ''}</div>`;
  if (job.server && (job.status === 'ready' || job.status === 'installing_timeout')) {
    const s = job.server;
    h += '<div style="margin-top:10px">';
    if (s.url) h += `<div class="server-row"><span class="muted">URL</span><span class="mono"><a href="${s.url}" target="_blank">${s.url}</a> ${copyBtn(s.url)}</span></div>`;
    if (s.ip) h += `<div class="server-row"><span class="muted">Server</span><span class="mono">${s.ip}${s.port ? ':' + s.port : ''} ${copyBtn(s.ip)}</span></div>`;
    if (s.username) h += `<div class="server-row"><span class="muted">Username</span><span class="mono">${s.username}</span></div>`;
    if (s.password) h += `<div class="server-row"><span class="muted">Password</span><span class="mono">${s.password} ${copyBtn(s.password)}</span></div>`;
    if (s.os) h += `<div class="server-row"><span class="muted">OS</span><span class="mono">${s.os}</span></div>`;
    h += '</div>';
  }
  if (job.logs && job.logs.length) h += `<div class="joblog">${job.logs.map((l) => String(l).replace(/</g, '&lt;')).join('\n')}</div>`;
  h += '</div>';
  return h;
}
function renderActiveJobs() {
  const ids = lsGetJobs(); const card = $('#active-jobs-card'); const box = $('#active-jobs');
  if (!box) return;
  if (!ids.length) { if (card) card.classList.add('hidden'); return; }
  if (card) card.classList.remove('hidden');
  box.innerHTML = ids.map((id) => (jobCache[id] ? jobCardHtml(jobCache[id]) : '')).join('') || '<span class="muted">Memuat…</span>';
}

// ---------- checkout (saldo / QRIS) ----------
const LS_CO = 'kobong_checkouts';
let coTimer = null; let curModalTrx = null;
function lsGetCO() { try { return JSON.parse(localStorage.getItem(LS_CO) || '[]'); } catch (_) { return []; } }
function lsSetCO(a) { localStorage.setItem(LS_CO, JSON.stringify(a.slice(-6))); }
function addCO(trx) { const a = lsGetCO(); if (!a.includes(trx)) { a.push(trx); lsSetCO(a); } ensureCOPolling(); }
function ensureCOPolling() { if (coTimer) return; coTimer = setInterval(pollCOs, 6000); pollCOs(); }
async function pollCOs() {
  const ids = lsGetCO();
  if (!ids.length) { if (coTimer) { clearInterval(coTimer); coTimer = null; } return; }
  for (const trx of ids) {
    try {
      const st = await api('/api/checkout/status?trx=' + encodeURIComponent(trx));
      if (st.status === 'paid' && st.jobId) { lsSetCO(lsGetCO().filter((x) => x !== trx)); trackJob(st.jobId); refreshBalance(); if (curModalTrx === trx) { $('#qr-status').innerHTML = '<div class="notice ok">✅ Dibayar! Proses dimulai.</div>'; setTimeout(() => { closeQrModal(); activateTab('dashboard'); }, 1200); } }
      else if (st.status === 'expired') { lsSetCO(lsGetCO().filter((x) => x !== trx)); if (curModalTrx === trx) $('#qr-status').innerHTML = '<div class="notice err">❌ QRIS kadaluarsa.</div>'; }
      else if (st.status === 'provision_failed') { lsSetCO(lsGetCO().filter((x) => x !== trx)); if (curModalTrx === trx) $('#qr-status').innerHTML = '<div class="notice err">❌ ' + (st.error || 'Gagal memproses.') + '</div>'; }
    } catch (_) {}
  }
}
function closeQrModal() { $('#qr-modal').classList.add('hidden'); curModalTrx = null; }
function openQrModal(res) {
  curModalTrx = res.transactionId; addCO(res.transactionId);
  $('#qr-amount').textContent = 'Bayar sebesar ' + fmtRp(res.amount) + ' — scan QRIS di bawah.';
  let holder = res.qrImage ? `<div class="qr"><img src="${res.qrImage}" alt="QRIS"/></div>` : '';
  if (res.paymentUrl) holder += `<div style="margin-top:10px"><a class="btn btn-primary" href="${res.paymentUrl}" target="_blank" rel="noopener">💳 Buka Halaman Pembayaran</a></div>`;
  if (!holder) holder = `<span class="muted">QR: ${res.qrString || '-'}</span>`;
  $('#qr-holder').innerHTML = holder;
  $('#qr-status').innerHTML = '<div class="notice info"><span class="spinner"></span> Menunggu pembayaran…</div>';
  $('#qr-modal').classList.remove('hidden');
}
$('#qr-close').addEventListener('click', closeQrModal);
function handleCheckoutResult(res, msgEl) {
  if (!res || !res.ok) { notice(msgEl, 'err', (res && res.error) || 'Gagal.'); return; }
  if (res.mode === 'balance') { notice(msgEl, 'ok', '✅ Dibayar pakai saldo. Progres di Dashboard → “Proses Berjalan”.'); trackJob(res.jobId); activateTab('dashboard'); refreshBalance(); return; }
  if (res.mode === 'qris') { notice(msgEl, 'ok', 'QRIS dibuat. Setelah dibayar, proses jalan otomatis (lihat Dashboard).'); openQrModal(res); return; }
  notice(msgEl, 'err', 'Respons tidak dikenali.');
}
async function submitOrder(kind, params, msgEl, btn) {
  btn.disabled = true; notice(msgEl, 'info', '<span class="spinner"></span> Memproses…');
  try { const res = await api('/api/order', { method: 'POST', body: JSON.stringify({ kind, params }) }); handleCheckoutResult(res, msgEl); }
  catch (_) { notice(msgEl, 'err', 'Terjadi kesalahan.'); }
  btn.disabled = false;
}

// ---------- dashboard ----------
async function loadMine() {
  const box = $('#my-rdp'); if (!box) return;
  try {
    const res = await api('/api/rdp/mine'); if (!res || !res.ok) return;
    const servers = res.servers || [];
    if ($('#d-rdpcount')) $('#d-rdpcount').textContent = servers.length;
    box.innerHTML = servers.length ? servers.map((s) => `<div class="server-row"><div><div class="mono">🖥️ ${s.server} ${copyBtn(s.ip)}</div><div class="muted" style="font-size:12px">${s.os || 'Windows'} · ${s.region} · administrator</div></div><div class="mono">${s.password ? '🔑 ' + s.password + copyBtn(s.password) : ''}</div></div>`).join('') : '<span class="muted">Belum ada layanan. Buat lewat tab Order.</span>';
  } catch (_) {}
}
async function loadTx() {
  const box = $('#tx-list'); if (!box) return;
  try {
    const res = await api('/api/tx'); if (!res || !res.ok) return;
    const tx = res.transactions || [];
    box.innerHTML = tx.length ? tx.map((t) => { const a = Number(t.amount); const pos = a >= 0; return `<div class="server-row"><div><span class="tag ${pos ? 'ok' : 'err'}">${t.type}</span> <span class="muted" style="font-size:12px">${t.created_at || ''}</span></div><div class="mono" style="color:${pos ? 'var(--ok)' : 'var(--err)'}">${pos ? '+' : ''}${fmtRp(a)}</div></div>`; }).join('') : '<span class="muted">Belum ada transaksi.</span>';
  } catch (_) {}
}

// ---------- shared helpers for order forms ----------
const DUR = [{ v: 1, k: 'daily', label: 'Harian (1 hari)' }, { v: 7, k: 'weekly', label: 'Mingguan (7 hari)' }, { v: 30, k: 'monthly', label: 'Bulanan (30 hari)' }];
function buildPkgGrid(products, gridEl, onSelect) {
  if (!products.length) { gridEl.innerHTML = '<span class="muted">Belum ada paket. Hubungi admin.</span>'; return; }
  gridEl.innerHTML = products.map((p, i) => {
    const prices = [p.price_daily, p.price_weekly, p.price_monthly].filter((x) => x != null);
    const minP = prices.length ? Math.min(...prices) : 0;
    const slots = Number(p.slot_daily || 0) + Number(p.slot_weekly || 0) + Number(p.slot_monthly || 0);
    return `<div class="pkg" data-i="${i}"><div class="spec">${p.ram}GB RAM</div><div class="muted">${p.core} vCPU</div><div class="price">mulai ${fmtRp(minP)}</div><div class="slot">${slots} slot</div></div>`;
  }).join('');
  $$('.pkg', gridEl).forEach((el) => el.addEventListener('click', () => onSelect(products[Number(el.dataset.i)], el, gridEl)));
}
function fillDurations(sel, pkg) {
  sel.innerHTML = '';
  DUR.forEach((d) => { const price = pkg['price_' + d.k]; const slot = Number(pkg['slot_' + d.k] || 0); if (price != null && slot > 0) { const o = document.createElement('option'); o.value = d.v; o.textContent = `${d.label} — ${fmtRp(price)} (${slot} slot)`; sel.appendChild(o); } });
  return sel.options.length > 0;
}

// ---------- Order RDP ----------
let rdpPkg = null;
async function loadRdpProducts() { try { const { products } = await api('/api/rdp/products'); buildPkgGrid(products || [], $('#rdp-pkg-grid'), selectRdpPkg); } catch (_) {} }
function selectRdpPkg(pkg, el) { rdpPkg = pkg; $$('#rdp-pkg-grid .pkg').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); if (!fillDurations($('#rdp-duration'), pkg)) { notice($('#rdp-msg'), 'err', 'Paket ini tidak ada slot.'); return; } $('#rdp-detail').classList.remove('hidden'); loadRdpOptions(); }
async function loadRdpOptions() {
  if (!rdpPkg) return; notice($('#rdp-msg'), '', '');
  const res = await api(`/api/rdp/options?ram=${rdpPkg.ram}&core=${rdpPkg.core}&duration=${$('#rdp-duration').value}`);
  if (!res.ok) { notice($('#rdp-msg'), 'err', res.error || 'Gagal memuat opsi.'); return; }
  $('#rdp-submit').dataset.productId = res.productId;
  $('#rdp-region').innerHTML = res.regions.length ? res.regions.map((r) => `<option value="${r.slug}">${r.slug} — ${r.name}</option>`).join('') : '<option value="">(tidak ada region)</option>';
  $('#rdp-os').innerHTML = res.osList.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
  $('#rdp-price').textContent = `Total: ${fmtRp(res.price)}`;
}
$('#rdp-duration').addEventListener('change', loadRdpOptions);
$('#rdp-passmode').addEventListener('change', (e) => $('#rdp-custompass-wrap').classList.toggle('hidden', e.target.value !== 'custom'));
$('#rdp-reset').addEventListener('click', () => { rdpPkg = null; $$('#rdp-pkg-grid .pkg').forEach((x) => x.classList.remove('sel')); $('#rdp-detail').classList.add('hidden'); notice($('#rdp-msg'), '', ''); });
$('#rdp-submit').addEventListener('click', (e) => {
  const productId = Number(e.currentTarget.dataset.productId); const regionSlug = $('#rdp-region').value; const osId = Number($('#rdp-os').value); const durationDays = Number($('#rdp-duration').value);
  const customPassword = $('#rdp-passmode').value === 'custom' ? $('#rdp-custompass').value : undefined;
  if (!productId || !regionSlug) { notice($('#rdp-msg'), 'err', 'Lengkapi pilihan dulu.'); return; }
  submitOrder('rdp_order', { productId, regionSlug, osId, durationDays, customPassword }, $('#rdp-msg'), e.currentTarget);
});

// ---------- Order VPS ----------
let vpsPkg = null;
async function loadVpsProducts() { try { const { products } = await api('/api/vps/products'); buildPkgGrid(products || [], $('#vps-pkg-grid'), selectVpsPkg); } catch (_) {} }
function selectVpsPkg(pkg, el) { vpsPkg = pkg; $$('#vps-pkg-grid .pkg').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); if (!fillDurations($('#vps-duration'), pkg)) { notice($('#vps-msg'), 'err', 'Paket ini tidak ada slot.'); return; } $('#vps-detail').classList.remove('hidden'); loadVpsOptions(); }
async function loadVpsOptions() {
  if (!vpsPkg) return; notice($('#vps-msg'), '', '');
  const res = await api(`/api/vps/options?ram=${vpsPkg.ram}&core=${vpsPkg.core}&duration=${$('#vps-duration').value}`);
  if (!res.ok) { notice($('#vps-msg'), 'err', res.error || 'Gagal memuat opsi.'); return; }
  $('#vps-submit').dataset.productId = res.productId;
  $('#vps-region').innerHTML = res.regions.length ? res.regions.map((r) => `<option value="${r.slug}">${r.slug} — ${r.name}</option>`).join('') : '<option value="">(tidak ada region)</option>';
  $('#vps-os').innerHTML = (res.images || []).map((o) => `<option value="${o.slug}">${o.label}</option>`).join('') || '<option value="">(default Ubuntu 22.04)</option>';
  $('#vps-price').textContent = `Total: ${fmtRp(res.price)}`;
}
$('#vps-duration').addEventListener('change', loadVpsOptions);
$('#vps-reset').addEventListener('click', () => { vpsPkg = null; $$('#vps-pkg-grid .pkg').forEach((x) => x.classList.remove('sel')); $('#vps-detail').classList.add('hidden'); notice($('#vps-msg'), '', ''); });
$('#vps-submit').addEventListener('click', (e) => {
  const productId = Number(e.currentTarget.dataset.productId); const regionSlug = $('#vps-region').value; const imageSlug = $('#vps-os').value || undefined; const durationDays = Number($('#vps-duration').value);
  if (!productId || !regionSlug) { notice($('#vps-msg'), 'err', 'Lengkapi pilihan dulu.'); return; }
  submitOrder('vps_order', { productId, regionSlug, imageSlug, durationDays }, $('#vps-msg'), e.currentTarget);
});

// ---------- Order Cloud9 / Fastpanel (produk + tombol durasi) ----------
function renderProductList(products, boxEl, kind, msgId) {
  if (!products.length) { boxEl.innerHTML = '<span class="muted">Belum ada produk. Hubungi admin.</span>'; return; }
  boxEl.innerHTML = products.map((p, i) => {
    let btns = '';
    if (p.price_weekly != null && Number(p.slot_weekly) > 0) btns += `<button class="btn btn-primary btn-sm buy" data-i="${i}" data-days="7">7 hari — ${fmtRp(p.price_weekly)}</button> `;
    if (p.price_monthly != null && Number(p.slot_monthly) > 0) btns += `<button class="btn btn-primary btn-sm buy" data-i="${i}" data-days="30">30 hari — ${fmtRp(p.price_monthly)}</button>`;
    if (!btns) btns = '<span class="muted">stok habis</span>';
    return `<div class="jobcard"><div><b>${p.ram}GB RAM / ${p.core} vCPU</b> <span class="muted">(${p.size_slug || '-'})</span></div><div class="row-flex" style="margin-top:8px">${btns}</div></div>`;
  }).join('');
  $$('.buy', boxEl).forEach((b) => b.addEventListener('click', () => {
    const p = products[Number(b.dataset.i)]; const days = Number(b.dataset.days);
    submitOrder(kind, { productId: p.id, durationDays: days }, $(msgId), b);
  }));
}
async function loadCloud9Products() { try { const { products } = await api('/api/cloud9/products'); renderProductList(products || [], $('#cloud9-products'), 'cloud9_order', '#cloud9-msg'); } catch (_) {} }
async function loadFastpanelProducts() { try { const { products } = await api('/api/fastpanel/products'); renderProductList(products || [], $('#fastpanel-products'), 'fastpanel_order', '#fastpanel-msg'); } catch (_) {} }

// ---------- Install forms ----------
async function loadInstallInfo() {
  try { const { osList } = await api('/api/rdp/os'); $('#irdp-os').innerHTML = (osList || []).map((o) => `<option value="${o.version}">${o.name}</option>`).join(''); } catch (_) {}
  try { const c = await api('/api/rdp/install-cost'); if (c && c.ok) $('#irdp-info').textContent = `Biaya jasa install RDP: ${fmtRp(c.installCost)}. Dibayar via saldo/QRIS. VPS wajib fresh Ubuntu.`; } catch (_) {}
  $('#ic9-info').textContent = 'Biaya install Cloud9 dibayar via saldo/QRIS. VPS fresh Ubuntu/Debian.';
  $('#ifp-info').textContent = 'Biaya install Fastpanel dibayar via saldo/QRIS. VPS fresh Ubuntu/Debian.';
}
$('#irdp-submit').addEventListener('click', (e) => {
  const ip = $('#irdp-ip').value.trim(); const sshUser = $('#irdp-user').value.trim() || 'root'; const sshPassword = $('#irdp-pass').value; const osVersion = $('#irdp-os').value; const provider = $('#irdp-provider').value; const rdpPassword = $('#irdp-rdppass').value.trim() || undefined;
  if (!ip || !sshPassword) { notice($('#irdp-msg'), 'err', 'IP & password SSH wajib.'); return; }
  submitOrder('rdp_install', { ip, sshUser, sshPassword, osVersion, rdpPassword, provider }, $('#irdp-msg'), e.currentTarget);
});
$('#ic9-submit').addEventListener('click', (e) => {
  const ip = $('#ic9-ip').value.trim(); const sshUser = $('#ic9-user').value.trim() || 'root'; const sshPassword = $('#ic9-pass').value;
  if (!ip || !sshPassword) { notice($('#ic9-msg'), 'err', 'IP & password SSH wajib.'); return; }
  submitOrder('cloud9_install', { ip, sshUser, sshPassword }, $('#ic9-msg'), e.currentTarget);
});
$('#ifp-submit').addEventListener('click', (e) => {
  const ip = $('#ifp-ip').value.trim(); const sshUser = $('#ifp-user').value.trim() || 'root'; const sshPassword = $('#ifp-pass').value;
  if (!ip || !sshPassword) { notice($('#ifp-msg'), 'err', 'IP & password SSH wajib.'); return; }
  submitOrder('fastpanel_install', { ip, sshUser, sshPassword }, $('#ifp-msg'), e.currentTarget);
});

// ---------- deposit ----------
$$('.dep-quick').forEach((b) => b.addEventListener('click', () => { $('#dep-amount').value = b.dataset.v; }));
let depTimer = null;
$('#dep-submit').addEventListener('click', async (e) => {
  const btn = e.currentTarget; const amount = Number($('#dep-amount').value);
  if (!amount || amount < 1000) { notice($('#dep-msg'), 'err', 'Minimal Rp 1.000.'); return; }
  btn.disabled = true; notice($('#dep-msg'), 'info', '<span class="spinner"></span> Membuat QRIS…');
  try {
    const res = await api('/api/deposit', { method: 'POST', body: JSON.stringify({ amount }) });
    if (!res.ok) { notice($('#dep-msg'), 'err', res.error || 'Gagal membuat QRIS.'); btn.disabled = false; return; }
    notice($('#dep-msg'), 'ok', 'QRIS dibuat. Scan & bayar ' + fmtRp(res.amount) + '.');
    $('#dep-qr-sub').textContent = 'Scan dengan e-wallet / m-banking (QRIS).';
    let depHolder = res.qrImage ? `<div class="qr"><img src="${res.qrImage}" alt="QRIS"/></div>` : '';
    if (res.paymentUrl) depHolder += `<div style="margin-top:10px"><a class="btn btn-primary" href="${res.paymentUrl}" target="_blank" rel="noopener">💳 Buka Halaman Pembayaran</a></div>`;
    if (!depHolder) depHolder = '<span class="muted">QR: ' + (res.qrString || '-') + '</span>';
    $('#dep-qr-holder').innerHTML = depHolder;
    $('#dep-status').innerHTML = '<div class="notice info"><span class="spinner"></span> Menunggu pembayaran…</div>';
    if (depTimer) clearInterval(depTimer);
    depTimer = setInterval(async () => {
      try { const st = await api(`/api/deposit/status?trx=${encodeURIComponent(res.transactionId)}&amount=${res.amount}`); if (st.status === 'success') { clearInterval(depTimer); $('#dep-status').innerHTML = '<div class="notice ok">✅ Pembayaran diterima! Saldo ditambahkan.</div>'; $('#dep-qr-holder').innerHTML = ''; refreshBalance(); loadTx(); } } catch (_) {}
    }, 6000);
  } catch (_) { notice($('#dep-msg'), 'err', 'Terjadi kesalahan.'); }
  btn.disabled = false;
});

// ---------- init ----------
(async function () {
  try {
    const me = await loadMe();
    await Promise.all([loadRdpProducts(), loadVpsProducts(), loadCloud9Products(), loadFastpanelProducts(), loadInstallInfo()]);
    if (me) { await loadMine(); await loadTx(); }
    renderActiveJobs();
    if (lsGetJobs().length) ensurePolling();
    if (lsGetCO().length) ensureCOPolling();
  } catch (_) {}
})();
