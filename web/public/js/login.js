// Landing page: cek sesi, tampilkan Telegram Login Widget, tangani auth.
(async function () {
  const hint = document.getElementById('login-hint');
  const msgBox = document.getElementById('login-msg');
  const showErr = (m) => { if (msgBox) { msgBox.textContent = m; msgBox.classList.remove('hidden'); } };

  // Jika sudah login, langsung ke dashboard.
  try {
    const me = await fetch('/api/me');
    if (me.ok) { window.location.href = '/app'; return; }
  } catch (_) {}

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ----- Daftar akun otomatis (username + password acak) -----
  const regBtn = document.getElementById('btn-register');
  const regResult = document.getElementById('register-result');
  if (regBtn) regBtn.addEventListener('click', async () => {
    if (msgBox) msgBox.classList.add('hidden');
    regBtn.disabled = true; regBtn.textContent = 'Membuat akun…';
    try {
      const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await r.json();
      if (r.ok && data.ok) {
        regBtn.classList.add('hidden');
        regResult.classList.remove('hidden');
        regResult.innerHTML =
          '<div class="notice ok" style="margin-bottom:10px">✅ Akun berhasil dibuat! <b>Simpan kredensial ini</b> — tidak akan ditampilkan lagi.</div>' +
          '<div class="cred-box">Username: <span class="mono">' + esc(data.username) + '</span>' +
          ' <span class="copy" id="cp-u">salin</span><br>Password: <span class="mono">' + esc(data.password) + '</span>' +
          ' <span class="copy" id="cp-p">salin</span></div>' +
          '<button class="btn btn-primary" id="btn-continue" style="width:100%">Saya sudah simpan — Lanjut ke Dashboard →</button>';
        const cpU = document.getElementById('cp-u'); if (cpU) cpU.onclick = () => navigator.clipboard.writeText(data.username);
        const cpP = document.getElementById('cp-p'); if (cpP) cpP.onclick = () => navigator.clipboard.writeText(data.password);
        const cont = document.getElementById('btn-continue'); if (cont) cont.onclick = () => { window.location.href = '/app'; };
      } else { showErr(data.error || 'Gagal membuat akun.'); regBtn.disabled = false; regBtn.textContent = '✨ Daftar (Buat Akun Otomatis)'; }
    } catch (e) { showErr('Tidak bisa menghubungi server.'); regBtn.disabled = false; regBtn.textContent = '✨ Daftar (Buat Akun Otomatis)'; }
  });

  // ----- Login username + password -----
  const loginBtn = document.getElementById('btn-login');
  async function doLogin() {
    if (msgBox) msgBox.classList.add('hidden');
    const username = (document.getElementById('login-username').value || '').trim();
    const password = document.getElementById('login-password').value || '';
    if (!username || !password) { showErr('Username & password wajib diisi.'); return; }
    loginBtn.disabled = true; loginBtn.textContent = 'Masuk…';
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await r.json();
      if (r.ok && data.ok) { window.location.href = '/app'; }
      else { showErr(data.error || 'Login gagal.'); loginBtn.disabled = false; loginBtn.textContent = 'Masuk'; }
    } catch (e) { showErr('Tidak bisa menghubungi server.'); loginBtn.disabled = false; loginBtn.textContent = 'Masuk'; }
  }
  if (loginBtn) loginBtn.addEventListener('click', doLogin);
  const passInput = document.getElementById('login-password');
  if (passInput) passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  // Callback global yang dipanggil Telegram Login Widget.
  window.onTelegramAuth = async function (user) {
    try {
      const r = await fetch('/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user)
      });
      const data = await r.json();
      if (r.ok && data.ok) { window.location.href = '/app'; }
      else { showErr(data.error || 'Login gagal.'); }
    } catch (e) { showErr('Tidak bisa menghubungi server.'); }
  };

  // Ambil username bot lalu suntikkan widget resmi Telegram.
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (!cfg.botUsername) {
      if (hint) hint.textContent = 'Login Telegram belum dikonfigurasi (set TELEGRAM_BOT_USERNAME di .env).';
      return;
    }
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', cfg.botUsername);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '10');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    s.setAttribute('data-request-access', 'write');
    const holder = document.getElementById('tg-login-btn');
    holder.innerHTML = '';
    holder.appendChild(s);
  } catch (e) {
    if (hint) hint.textContent = 'Gagal memuat konfigurasi login.';
  }
})();
