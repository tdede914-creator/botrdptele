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
