const { isAdmin } = require('../utils/userManager');
const vpsManager = require('../utils/vpsManager');
const { getSizes, deleteDroplet, powerDroplet, getAccountHealth } = require('../utils/doApi');
const safeMessageEditor = require('../utils/safeMessageEdit');

async function showVpsAdminMenu(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;

  const kb = [
    [{ text: '➕ Tambah API DO', callback_data: 'vps_admin_add_api' }],
    [{ text: '➕ Tambah API Linode', callback_data: 'vps_admin_add_linode_api' }],
    [{ text: '➕ Tambah API AWS', callback_data: 'vps_admin_add_aws_api' }],
    [{ text: '➕ Tambah API UpCloud', callback_data: 'vps_admin_add_upcloud_api' }],
    [{ text: '⛔ Nonaktifkan API Cloud', callback_data: 'vps_admin_disable_api' }],
    [{ text: '🗑️ Hapus API Cloud (Permanen)', callback_data: 'vps_admin_del_api' }],
    [{ text: '➕ Tambah Spesifikasi VPS/RDP', callback_data: 'vps_admin_add_prod_combo' }],
    [{ text: '☁️ Admin Cloud9', callback_data: 'cloud9_admin' }],
    [{ text: '⚡ Admin Fastpanel', callback_data: 'fastpanel_admin' }],
    [{ text: '🗑️ Delete Stok VPS/RDP', callback_data: 'vps_admin_stock_provider' }],
    [{ text: '💲 Ubah Harga VPS/RDP', callback_data: 'vps_admin_price_provider' }],
    [{ text: '💲 Ubah Harga Install RDP', callback_data: 'vps_admin_install_price' }],
    [{ text: '📋 List VPS&RDP', callback_data: 'vps_admin_list_services' }],
    [{ text: '📦 Backup / Restore Data VPS&RDP', callback_data: 'vps_admin_backup_menu' }],
    [{ text: '🔍 Cek Status Akun Cloud', callback_data: 'vps_admin_check_do' }],
    [{ text: '🔌 TURN ON / TURN OFF VPS&RDP', callback_data: 'vps_admin_power_menu' }],
    [{ text: '🔥 Hapus VPS (ADMIN)', callback_data: 'vps_admin_del_vps' }],
    [{ text: '🏠 Kembali', callback_data: 'back_to_menu' }]
  ];

  return safeMessageEditor.editMessage(bot, chatId, messageId, '⚙️ *PANEL VPS ADMIN*', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function showDisableApiMenu(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;

  const apis = await vpsManager.listDoApis();
  if (!apis.length) {
    return bot.sendMessage(chatId, '❌ Tidak ada API DO.');
  }

  const kb = apis.map(a => {
    const base = vpsManager.formatApiLabel ? vpsManager.formatApiLabel(a) : (a.email ? `${a.email} - API#${a.id}` : `API#${a.id}`);
    const label = (Number(a.status) === 1) ? `⛔ Nonaktifkan • ${base}` : `✅ Sudah DISABLED • ${base}`;
    return ([{ text: label, callback_data: `vps_disableapi:${a.id}` }]);
  });
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih API yang akan dinonaktifkan (DISABLE):', {
    reply_markup: { inline_keyboard: kb }
  });
}

async function showDelApiMenu(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;

  const apis = await vpsManager.listDoApis();
  if (!apis.length) {
    return bot.sendMessage(chatId, '❌ Tidak ada API DO.');
  }

  const kb = apis.map(a => {
    const base = vpsManager.formatApiLabel ? vpsManager.formatApiLabel(a) : (a.email ? `${a.email} - API#${a.id}` : `API#${a.id}`);
    const label = (Number(a.status) === 1) ? base : `⛔ ${base} (DISABLED)`;
    return ([{ text: label, callback_data: `vps_delapi:${a.id}` }]);
  });
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '⚠️ *Hapus Permanen*\n\nPilih API yang akan dihapus PERMANEN:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function disableApi(bot, chatId, messageId, apiId) {
  if (!isAdmin(chatId)) return;

  // If already disabled, just inform.
  const apis = await vpsManager.listDoApis();
  const found = apis.find(a => Number(a.id) === Number(apiId));
  if (found && Number(found.status) === 0) {
    return bot.sendMessage(chatId, 'ℹ️ API ini sudah DISABLED.\n\nKetik /start untuk kembali.');
  }

  await vpsManager.disableDoApi(apiId);
  return bot.sendMessage(chatId, '✅ API berhasil dinonaktifkan (DISABLED).\nStok API ini otomatis dinonaktifkan supaya tidak dipakai order.\n\nKetik /start untuk kembali.');
}

async function deleteApi(bot, chatId, messageId, apiId) {
  if (!isAdmin(chatId)) return;

  // Permanent delete: this will also remove VPS history related to this API (vps_instances)
  await vpsManager.deleteDoApiPermanent(apiId);
  return bot.sendMessage(chatId, '✅ API berhasil dihapus *permanen*.\n\nKetik /start untuk kembali.', { parse_mode: 'Markdown' });
}


async function pickProviderForAddProduct(bot, chatId, messageId, productType = 'vps') {
  if (!isAdmin(chatId)) return;
  const kb = [
    [{ text: '🌊 Provider DigitalOcean', callback_data: `vps_prod_provider:${productType}:digitalocean` }],
    [{ text: '🟣 Provider Linode', callback_data: `vps_prod_provider:${productType}:linode` }],
    [{ text: '🟠 Provider AWS', callback_data: `vps_prod_provider:${productType}:aws` }],
    [{ text: '🟢 Provider UpCloud', callback_data: `vps_prod_provider:${productType}:upcloud` }],
    [{ text: '☁️ Semua Provider', callback_data: `vps_prod_provider:${productType}:all` }],
    [{ text: '« Kembali', callback_data: 'vps_admin' }]
  ];
  return safeMessageEditor.editMessage(bot, chatId, messageId, `Pilih provider untuk tambah spesifikasi ${productType.toUpperCase()}:`, { reply_markup: { inline_keyboard: kb } });
}

async function pickApiForAddProduct(bot, chatId, messageId, productType = 'vps', provider = 'all') {
  if (!isAdmin(chatId)) return;

  const apis = await vpsManager.listApisByProvider ? await vpsManager.listApisByProvider(provider) : await vpsManager.listDoApis();
  if (!apis.length) {
    return bot.sendMessage(chatId, '❌ Belum ada API untuk provider ini. Tambahkan API cloud dulu.');
  }

  const kb = apis.map(a => {
    const base = vpsManager.formatApiLabel ? vpsManager.formatApiLabel(a) : (a.email ? `${a.email} - API#${a.id}` : `API#${a.id}`);
    const label = (Number(a.status) === 1) ? base : `⛔ ${base} (DISABLED)`;
    return ([{ text: label, callback_data: `vps_prod_api:${productType}:${a.id}` }]);
  });
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, (`Pilih API Cloud untuk ambil list spesifikasi ${productType.toUpperCase()}:`), {
    reply_markup: { inline_keyboard: kb }
  });
}

async function pickSizeMenu(bot, chatId, messageId, productType, apiId, page = 0) {
  if (!isAdmin(chatId)) return;

  const token = await vpsManager.getDoApiToken(apiId);
  if (!token) return bot.sendMessage(chatId, '❌ Token API tidak ditemukan.');

  const sizes = await getSizes(token);
  if (!sizes.length) return bot.sendMessage(chatId, '❌ Tidak ada size tersedia.');

  const perPage = 12;
  const totalPages = Math.max(1, Math.ceil(sizes.length / perPage));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);

  const start = safePage * perPage;
  const pageItems = sizes.slice(start, start + perPage);

  const kb = pageItems.map(s => ([{
    // Tampilkan biaya per bulan dari provider cloud agar admin bisa memilih size dengan tepat
    text: `${s.slug} (${Math.floor(s.memory/1024)}GB / ${s.vcpus} CORE) • $${Number(s.price_monthly || 0).toFixed(2)}/mo`,
    callback_data: `vps_prod_size:${productType}:${apiId}:${s.slug}:${Math.floor(s.memory/1024)}:${s.vcpus}`
  }]));

  const navRow = [];
  if (safePage > 0) navRow.push({ text: '⬅️ Halaman sebelumnya', callback_data: `vps_prod_sizepage:${productType}:${apiId}:${safePage - 1}` });
  navRow.push({ text: `📄 ${safePage + 1}/${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) navRow.push({ text: '➡️ Halaman berikutnya', callback_data: `vps_prod_sizepage:${productType}:${apiId}:${safePage + 1}` });
  kb.push(navRow);

  kb.push([{ text: '« Kembali', callback_data: `vps_admin_add_prod_${productType}` }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, `Pilih spesifikasi (size):

Menampilkan ${start + 1}-${start + pageItems.length} dari ${sizes.length}`, {
    reply_markup: { inline_keyboard: kb }
  });
}

async function showDelVpsByApiMenu(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;

  const apis = await vpsManager.listDoApis();
  if (!apis.length) return bot.sendMessage(chatId, '❌ Tidak ada API.');

  const kb = apis.map(a => {
    const base = vpsManager.formatApiLabel ? vpsManager.formatApiLabel(a) : (a.email ? `${a.email} - API#${a.id}` : `API#${a.id}`);
    const label = (Number(a.status) === 1) ? base : `⛔ ${base} (DISABLED)`;
    return ([{ text: label, callback_data: `vps_delvps_api:${a.id}` }]);
  });
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih API VPS:', {
    reply_markup: { inline_keyboard: kb }
  });
}

async function showVpsListForDelete(bot, chatId, messageId, apiId) {
  if (!isAdmin(chatId)) return;

  const rows = await vpsManager.listActiveVpsByApi(apiId);
  if (!rows.length) {
    return bot.sendMessage(chatId, '❌ Tidak ada VPS aktif untuk API ini.');
  }

  const kb = rows.slice(0, 40).map(r => ([{
    text: `${r.ip || '-'} | DROP ${r.droplet_id} | UID ${r.user_id}`,
    callback_data: `vps_del_inst:${r.id}`
  }]));
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin_del_vps' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, 'Pilih VPS yang akan dihapus:', {
    reply_markup: { inline_keyboard: kb }
  });
}



async function showProviderFilterMenu(bot, chatId, messageId, target = 'stock') {
  if (!isAdmin(chatId)) return;
  const prefix = target === 'price' ? 'vps_price_provider' : 'vps_stock_provider';
  const title = target === 'price' ? '💲 Ubah Harga VPS/RDP' : '🗑️ Delete Stok VPS/RDP';
  const kb = [
    [{ text: '🌊 Provider DigitalOcean', callback_data: `${prefix}:digitalocean` }],
    [{ text: '🟣 Provider Linode', callback_data: `${prefix}:linode` }],
    [{ text: '🟠 Provider AWS', callback_data: `${prefix}:aws` }],
    [{ text: '☁️ Semua Provider', callback_data: `${prefix}:all` }],
    [{ text: '« Kembali', callback_data: 'vps_admin_stock_provider' }]
  ];
  return safeMessageEditor.editMessage(bot, chatId, messageId, `${title}

Pilih provider:`, { reply_markup: { inline_keyboard: kb } });
}

async function showStockTypeMenu(bot, chatId, messageId, provider = 'all') {
  if (!isAdmin(chatId)) return;

  // Stok VPS dan RDP sudah shared (combo). Cukup 3 tombol per durasi.
  // Kita tetap kirim 'combo' sebagai productType ke callback lama supaya
  // family filter di vpsManager mencocokkan semua vps/rdp/combo rows.
  const kb = [
    [{ text: '🗑️ DELETE Stok Harian', callback_data: `vps_stock_group:${provider}:combo:1:0` }],
    [{ text: '🗑️ DELETE Stok Mingguan', callback_data: `vps_stock_group:${provider}:combo:7:0` }],
    [{ text: '🗑️ DELETE Stok Bulanan', callback_data: `vps_stock_group:${provider}:combo:30:0` }],
    [{ text: '« Kembali', callback_data: 'vps_admin' }]
  ];

  return safeMessageEditor.editMessage(bot, chatId, messageId, '🗑️ *DELETE Stok VPS/RDP*\n\nStok VPS & RDP sekarang dibagi bersama (1 pool per spek). Pilih durasi yang ingin dikurangi:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function showStockGroupMenu(bot, chatId, messageId, productType = 'vps', durationDays = 30, page = 0, provider = 'all') {
  if (!isAdmin(chatId)) return;

  let groups = await vpsManager.listActiveProductGroupsByDuration(productType, Number(durationDays));
  if (provider !== 'all' && vpsManager.listActiveProductProviders) {
    // Provider filtering is applied in the API selection step; here keep visible groups that have provider stock.
    const filtered = [];
    for (const g of groups) {
      const ps = await vpsManager.listActiveProductProviders(productType, g.ram, g.core, Number(durationDays));
      if (ps.some(x => String(x.provider) === String(provider))) filtered.push(g);
    }
    groups = filtered;
  }
  if (!groups.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Tidak ada stok aktif untuk produk ini.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_stock' }]] }
    });
  }

  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(groups.length / perPage));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);

  const start = safePage * perPage;
  const items = groups.slice(start, start + perPage);

  const kb = items.map(g => {
    const label = `RAM ${g.ram}GB / ${g.core} CORE • Rp ${Number(g.price).toLocaleString('id-ID')} • Stok ${g.slot}`;
    const cb = `vps_stock_api:${provider}:${productType}:${durationDays}:${g.ram}:${g.core}`;
    return ([{ text: label, callback_data: cb }]);
  });

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Halaman sebelumnya', callback_data: `vps_stock_group:${provider}:${productType}:${durationDays}:${safePage - 1}` });
  nav.push({ text: `📄 ${safePage + 1}/${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) nav.push({ text: '➡️ Halaman berikutnya', callback_data: `vps_stock_group:${provider}:${productType}:${durationDays}:${safePage + 1}` });
  kb.push(nav);

  kb.push([{ text: '« Kembali', callback_data: `vps_stock_provider:${provider}` }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, `Pilih spesifikasi ${productType.toUpperCase()} (${durationDays} hari) yang ingin dikurangi stoknya:`, {
    reply_markup: { inline_keyboard: kb }
  });
}

async function showStockApiMenu(bot, chatId, messageId, productType, durationDays, ram, core, provider = 'all') {
  if (!isAdmin(chatId)) return;

  let rows = await vpsManager.listActiveProductsByGroupDuration(productType, Number(ram), Number(core), Number(durationDays));
  if (provider !== 'all') rows = rows.filter(r => { const p = String(vpsManager.getApiProvider ? vpsManager.getApiProvider({ token: r.token || '' }) : ''); return true; });
  if (provider !== 'all') {
    const apis = await vpsManager.listApisByProvider(provider);
    const ids = new Set(apis.map(a => Number(a.id)));
    rows = rows.filter(r => ids.has(Number(r.api_id)));
  }
  if (!rows.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Stok tidak ditemukan / sudah habis.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: `vps_stock_group:${provider}:${productType}:${durationDays}:0` }]] }
    });
  }

  const kb = rows.map(r => {
    const labelBase = r.email ? `${r.email} - API#${r.api_id}` : `API#${r.api_id}`;
    const label = `➖ ${labelBase} • slot ${r.slot} • ${r.size_slug}`;
    const cb = `vps_stock_dec:${r.id}:${provider}:${productType}:${durationDays}:${ram}:${core}`;
    return ([{ text: label, callback_data: cb }]);
  });

  kb.push([{ text: '« Kembali', callback_data: `vps_stock_group:${provider}:${productType}:${durationDays}:0` }]);

  const durLabel = Number(durationDays) === 1 ? 'Harian' : (Number(durationDays) === 7 ? 'Mingguan' : 'Bulanan');
  const priceInfo = rows[0]?.price;
  const title = `🗑️ Delete Stok ${productType.toUpperCase()} (${durLabel})

Spesifikasi: RAM ${ram}GB / ${core} CORE
Harga: Rp ${Number(priceInfo || 0).toLocaleString('id-ID')}

Pilih API yang stoknya mau dikurangi (mengurangi 1 slot):`;
  return safeMessageEditor.editMessage(bot, chatId, messageId, title, {
    reply_markup: { inline_keyboard: kb }
  });
}

async function showPriceTypeMenu(bot, chatId, messageId, provider = 'all') {
  if (!isAdmin(chatId)) return;

  // Harga VPS & RDP sekarang shared per spek (combo). Skip pilih tipe,
  // langsung ke daftar spek. Kita passing 'combo' ke callback lama supaya
  // family filter di vpsManager mencocokkan semua vps/rdp/combo rows.
  return showPriceSpecMenu(bot, chatId, messageId, 'combo', 0, provider);
}

async function showPriceSpecMenu(bot, chatId, messageId, productType = 'vps', page = 0, provider = 'all') {
  if (!isAdmin(chatId)) return;

  const specs = await vpsManager.listActiveSpecSummaries(productType);
  if (!specs.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Tidak ada stok aktif untuk produk ini.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_price' }]] }
    });
  }

  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(specs.length / perPage));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);

  const start = safePage * perPage;
  const items = specs.slice(start, start + perPage);

  const kb = items.map(s => {
    const minD = (s.min_price_daily == null) ? null : Number(s.min_price_daily);
    const maxD = (s.max_price_daily == null) ? null : Number(s.max_price_daily);
    const minW = (s.min_price_weekly == null) ? null : Number(s.min_price_weekly);
    const maxW = (s.max_price_weekly == null) ? null : Number(s.max_price_weekly);
    const minM = (s.min_price_monthly == null) ? null : Number(s.min_price_monthly);
    const maxM = (s.max_price_monthly == null) ? null : Number(s.max_price_monthly);

    const dailyLabel = (minD == null) ? '-' : ((minD === maxD) ? `Rp ${minD.toLocaleString('id-ID')}` : `Rp ${minD.toLocaleString('id-ID')} - ${maxD.toLocaleString('id-ID')}`);
    const weeklyLabel = (minW == null) ? '-' : ((minW === maxW) ? `Rp ${minW.toLocaleString('id-ID')}` : `Rp ${minW.toLocaleString('id-ID')} - ${maxW.toLocaleString('id-ID')}`);
    const monthlyLabel = (minM == null) ? '-' : ((minM === maxM) ? `Rp ${minM.toLocaleString('id-ID')}` : `Rp ${minM.toLocaleString('id-ID')} - ${maxM.toLocaleString('id-ID')}`);
    const priceLabel = `Harian ${dailyLabel} | Mingguan ${weeklyLabel} | Bulanan ${monthlyLabel}`;
    const label = `RAM ${s.ram}GB / ${s.core} CORE • ${priceLabel} • Stok ${s.slot}`;
    const cb = `vps_price_spec:${productType}:${s.ram}:${s.core}`;
    return ([{ text: label, callback_data: cb }]);
  });

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Halaman sebelumnya', callback_data: `vps_price_type:${provider}:${productType}:${safePage - 1}` });
  nav.push({ text: `📄 ${safePage + 1}/${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) nav.push({ text: '➡️ Halaman berikutnya', callback_data: `vps_price_type:${provider}:${productType}:${safePage + 1}` });
  kb.push(nav);

  // Back goes to provider selection instead of the now-removed VPS/RDP type step.
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin_price_provider' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, `Pilih spesifikasi VPS/RDP yang ingin diubah harganya (harga sama untuk VPS dan RDP karena stok dibagi bersama):`, {
    reply_markup: { inline_keyboard: kb }
  });
}

async function showInstallPriceMenu(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;

  const kb = [
    [{ text: '💲 Ubah Harga Install RDP', callback_data: 'set_install_rdp_cost' }],
    [{ text: '💲 Ubah Harga Dedicated RDP Installer', callback_data: 'set_dedicated_install_rdp_cost' }],
    [{ text: '« Kembali', callback_data: 'vps_admin' }]
  ];

  return safeMessageEditor.editMessage(bot, chatId, messageId, '💲 *Ubah Harga Install RDP*\n\nPilih yang ingin diubah:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

function fmtDateShort(sec) {
  if (!sec) return '-';
  const d = new Date(Number(sec) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + '-' + d.getFullYear();
}

function formatBuyerLabel(row) {
  const id = row && row.user_id ? String(row.user_id) : '-';
  const username = row && row.buyer_username ? String(row.buyer_username).replace(/^@/, '') : '';
  return username ? `${id}/@${username}` : id;
}

function formatApiHeader(row) {
  const scope = row && row.api_scope === 'renter' ? 'RENTER API' : 'API';
  const apiId = row && row.api_id ? String(row.api_id) : '-';
  const email = row && row.api_email ? String(row.api_email) : '-';
  return `${scope}#${apiId} EMAIL: ${email}`;
}

async function showAdminServiceList(bot, chatId, messageId, page = 0) {
  if (!isAdmin(chatId)) return;

  // API-FIRST: tampilkan daftar API dulu (bukan langsung semua server).
  // Klik salah satu API -> baru muncul list VPS/RDP milik API itu.
  // EXCLUDE renter (source === 'renter') karena beda cakupan (data renter
  // ada di menu Sewa/Renter tersendiri, bukan di admin list order).
  const allRows = await vpsManager.listAllActiveInstances();
  const rows = allRows.filter(r => r.source !== 'renter');
  if (!rows.length) {
    const emptyText = '📋 LIST VPS&RDP\n\nBelum ada VPS/RDP aktif (di luar renter).';
    const opts = { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin' }]] } };
    const res = await safeMessageEditor.editMessage(bot, chatId, messageId, emptyText, opts);
    if (!res || res.success === false) return bot.sendMessage(chatId, emptyText, opts);
    return res;
  }

  // Kelompokkan per API.
  const groups = new Map();
  for (const r of rows) {
    const key = r.api_id != null ? String(r.api_id) : 'none';
    if (!groups.has(key)) groups.set(key, { apiId: r.api_id, email: r.api_email, rdp: 0, vps: 0 });
    const g = groups.get(key);
    if (vpsManager.isRdpInstance(r)) g.rdp += 1; else g.vps += 1;
  }

  const kb = [];
  for (const g of groups.values()) {
    const email = g.email ? ` ${g.email}` : '';
    const label = `API#${g.apiId != null ? g.apiId : '-'}${email} — ${g.rdp} RDP / ${g.vps} VPS`;
    kb.push([{ text: label, callback_data: 'vps_admin_list_api:' + (g.apiId != null ? g.apiId : 'none') }]);
  }
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin' }]);

  const listText = '📋 *LIST VPS&RDP AKTIF*\n\nPilih API untuk melihat daftar server-nya:\n_(data renter tidak termasuk — ada di menu Sewa)_';
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } };
  const res = await safeMessageEditor.editMessage(bot, chatId, messageId, listText, opts);
  if (!res || res.success === false) return bot.sendMessage(chatId, listText, opts);
  return res;
}

// Detail server milik satu API (dipanggil setelah admin klik API di list).
// Tetap exclude renter. Pagination 18 per halaman.
async function showAdminServiceListByApi(bot, chatId, messageId, apiId, page = 0) {
  if (!isAdmin(chatId)) return;

  const allRows = await vpsManager.listAllActiveInstances();
  const rows = allRows.filter(r => r.source !== 'renter' && String(r.api_id != null ? r.api_id : 'none') === String(apiId));

  if (!rows.length) {
    const emptyText = '📋 LIST VPS&RDP\n\nTidak ada server aktif untuk API ini.';
    const opts = { reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_list_services' }]] } };
    const res = await safeMessageEditor.editMessage(bot, chatId, messageId, emptyText, opts);
    if (!res || res.success === false) return bot.sendMessage(chatId, emptyText, opts);
    return res;
  }

  const perPage = 18;
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const items = rows.slice(safePage * perPage, safePage * perPage + perPage);

  const header = formatApiHeader(items[0]);
  const lines = [header, ''];
  for (const r of items) {
    const type = (vpsManager.isRdpInstance(r) ? 'rdp' : 'vps').toUpperCase();
    const ip = r.ip ? (type === 'RDP' ? String(r.ip) + ':' + (r.rdp_port || 4443) : String(r.ip)) : '-';
    const exp = fmtDateShort(r.expires_at);
    const buyer = formatBuyerLabel(r);
    lines.push(`${type} ${ip} EXP ${exp} BUYER (${buyer})`);
  }

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Sebelumnya', callback_data: 'vps_admin_list_api:' + apiId + ':' + (safePage - 1) });
  nav.push({ text: (safePage + 1) + '/' + totalPages, callback_data: 'noop' });
  if (safePage < totalPages - 1) nav.push({ text: '➡️ Berikutnya', callback_data: 'vps_admin_list_api:' + apiId + ':' + (safePage + 1) });

  const kb = [];
  if (totalPages > 1) kb.push(nav);
  kb.push([{ text: '« Pilih API lain', callback_data: 'vps_admin_list_services' }]);
  kb.push([{ text: '🏠 Menu Admin', callback_data: 'vps_admin' }]);

  const listText = '📋 LIST VPS&RDP AKTIF\nTotal API ini: ' + rows.length + '\n\n' + lines.join('\n');
  const opts = { reply_markup: { inline_keyboard: kb } };
  const res = await safeMessageEditor.editMessage(bot, chatId, messageId, listText, opts);
  if (!res || res.success === false) return bot.sendMessage(chatId, listText, opts);
  return res;
}



function formatUsdValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return '$' + n.toFixed(2);
}

function accountStatusEmoji(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'ACTIVE') return '✅';
  if (s === 'WARNING') return '⚠️';
  if (s === 'LOCKED' || s === 'SUSPENDED' || s === 'INVALID/LOCKED') return '🚫';
  return '❌';
}


async function showAdminBackupServiceList(bot, chatId, messageId, page = 0) {
  if (!isAdmin(chatId)) return;
  const rows = await vpsManager.listAllActiveInstances();
  if (!rows.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '📦 *BACKUP / RESTORE DATA VPS&RDP*\n\nBelum ada VPS/RDP aktif.', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin' }]] }
    });
  }

  const perPage = 12;
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const items = rows.slice(safePage * perPage, safePage * perPage + perPage);

  const kb = items.map(r => {
    const type = (vpsManager.isRdpInstance(r) ? 'rdp' : 'vps').toUpperCase();
    const ip = r.ip ? (type === 'RDP' ? String(r.ip) + ':' + (r.rdp_port || 4443) : String(r.ip)) : '-';
    const src = r.source === 'renter' ? 'renter' : 'order';
    const backupId = src === 'renter' ? -Math.abs(Number(r.id)) : Number(r.id);
    return [{ text: `${type} ${ip} | Buyer ${r.user_id || '-'}${src === 'renter' ? ' | RENTER' : ''}`, callback_data: `backup_menu:${backupId}` }];
  });

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Halaman sebelumnya', callback_data: 'vps_admin_backup_menu:' + (safePage - 1) });
  nav.push({ text: (safePage + 1) + '/' + totalPages, callback_data: 'noop' });
  if (safePage < totalPages - 1) nav.push({ text: '➡️ Halaman berikutnya', callback_data: 'vps_admin_backup_menu:' + (safePage + 1) });
  if (totalPages > 1) kb.push(nav);
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId, '📦 *BACKUP / RESTORE DATA VPS&RDP*\n\nPilih server:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function showDoStatusMenu(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;
  const apis = await vpsManager.listDoApis();
  if (!apis.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '❌ Belum ada API DO/Linode.', {
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin' }]] }
    });
  }
  const kb = apis.map(a => {
    const base = vpsManager.formatApiLabel ? vpsManager.formatApiLabel(a) : (a.email ? `${a.email} - API#${a.id}` : `API#${a.id}`);
    const label = (Number(a.status) === 1) ? base : `⛔ ${base} (DISABLED)`;
    return [{ text: label, callback_data: `vps_do_status:${a.id}` }];
  });
  kb.unshift([{ text: '🔎 Cek Semua API', callback_data: 'vps_do_status_all' }]);
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin' }]);
  return safeMessageEditor.editMessage(bot, chatId, messageId, '🔍 *CEK STATUS AKUN CLOUD*\n\nPilih API yang ingin dicek:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function buildDoStatusText(apiRow) {
  if (!apiRow || !apiRow.token) return '❌ API tidak ditemukan.';
  const info = await getAccountHealth(apiRow.token);
  const account = info.account || {};
  const balance = info.balance || {};
  const status = info.status || 'UNKNOWN';
  const email = account.email || apiRow.email || '-';
  const uuid = account.uuid || '-';
  const dropletLimit = account.droplet_limit ?? '-';
  const floatingIpLimit = account.floating_ip_limit ?? '-';
  const emailVerified = account.email_verified === true ? 'Ya' : (account.email_verified === false ? 'Tidak' : '-');
  const creditLimit = formatUsdValue(balance.account_balance);
  const monthToDate = formatUsdValue(balance.month_to_date_balance);
  const generatedAt = balance.generated_at ? String(balance.generated_at) : '-';
  const dropletCount = info.dropletCount === null || info.dropletCount === undefined ? '-' : info.dropletCount;
  const creditSummary = info.creditSummary || { detectedTotal: 0, rows: [] };
  let text = '🔍 STATUS AKUN ' + (vpsManager.getApiProvider ? vpsManager.getApiProvider(apiRow).toUpperCase() : 'CLOUD') + '\n\n';
  text += `API: ${(vpsManager.getApiProvider ? vpsManager.getApiProvider(apiRow) : 'API')}#${apiRow.id}\n`;
  text += `Email: ${email}\n`;
  text += `Status: ${accountStatusEmoji(status)} ${status}\n`;
  text += `Email Verified: ${emailVerified}\n`;
  text += `UUID: ${uuid}\n\n`;
  text += `💳 Billing/Credit\n`;
  text += `Balance/tagihan API: ${creditLimit}\n`;
  text += `Pemakaian bulan ini: ${monthToDate}\n`;
  text += `Promo/Credit terdeteksi: ${creditSummary.detectedTotal ? formatUsdValue(creditSummary.detectedTotal) : '-'}\n`;
  if (creditSummary.rows && creditSummary.rows.length) {
    text += `Riwayat credit terbaru:\n`;
    for (const row of creditSummary.rows) {
      const amt = row.amount === null || row.amount === undefined ? '-' : formatUsdValue(row.amount);
      text += `• ${row.date} - ${amt} - ${row.description}\n`;
    }
  }
  text += `Update billing: ${generatedAt}\n\n`;
  text += `📦 Droplet/Limit\n`;
  text += `Jumlah droplet terpakai: ${dropletCount}\n`;
  text += `Droplet limit: ${dropletLimit}\n`;
  text += `Floating IP limit: ${floatingIpLimit}\n`;
  if (info.accountError) text += `\nAccount API Error: ${info.accountError}`;
  if (info.balanceError) text += `\nBilling API Error: ${info.balanceError}`;
  if (info.billingHistoryError) text += `\nBilling History API Error: ${info.billingHistoryError}`;
  if (info.dropletsError) text += `\nDroplet API Error: ${info.dropletsError}`;
  return text;
}

async function showDoStatus(bot, chatId, messageId, apiId) {
  if (!isAdmin(chatId)) return;
  const api = await vpsManager.getDoApiById(apiId);
  if (!api) return bot.sendMessage(chatId, '❌ API tidak ditemukan.');
  await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ Mengecek status akun API#' + apiId + '...', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_check_do' }]] }
  });
  const text = await buildDoStatusText(api);
  return bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: [[{ text: '🔍 Cek API Lain', callback_data: 'vps_admin_check_do' }], [{ text: '🏠 VPS Admin', callback_data: 'vps_admin' }]] }
  });
}

async function showAllDoStatus(bot, chatId, messageId) {
  if (!isAdmin(chatId)) return;
  const apis = await vpsManager.listDoApis();
  if (!apis.length) return bot.sendMessage(chatId, '❌ Belum ada API DO/Linode.');
  await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ Mengecek semua API Cloud...', {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_check_do' }]] }
  });
  const lines = ['🔍 RINGKASAN STATUS API CLOUD', ''];
  for (const api of apis) {
    const info = await getAccountHealth(api.token);
    const account = info.account || {};
    const balance = info.balance || {};
    const email = account.email || api.email || '-';
    const creditSummary = info.creditSummary || { detectedTotal: 0 };
    const dropletCount = info.dropletCount === null || info.dropletCount === undefined ? '-' : info.dropletCount;
    lines.push(`${accountStatusEmoji(info.status)} API#${api.id} • ${email}`);
    lines.push(`Status: ${info.status || 'UNKNOWN'} • Droplet: ${dropletCount} • Balance: ${formatUsdValue(balance.account_balance)} • MTD: ${formatUsdValue(balance.month_to_date_balance)} • Credit: ${creditSummary.detectedTotal ? formatUsdValue(creditSummary.detectedTotal) : '-'}`);
    if (info.accountError) lines.push(`Error: ${info.accountError}`);
    if (info.billingHistoryError) lines.push(`Billing history: ${info.billingHistoryError}`);
    if (info.dropletsError) lines.push(`Droplet count: ${info.dropletsError}`);
    lines.push('');
  }
  const text = lines.join('\n');
  const chunks = [];
  for (let i = 0; i < text.length; i += 3800) chunks.push(text.slice(i, i + 3800));
  for (let i = 0; i < chunks.length; i++) {
    await bot.sendMessage(chatId, chunks[i], {
      reply_markup: i === chunks.length - 1 ? { inline_keyboard: [[{ text: '🔍 Menu Cek Status', callback_data: 'vps_admin_check_do' }], [{ text: '🏠 VPS Admin', callback_data: 'vps_admin' }]] } : undefined
    });
  }
}

function powerSourceForRow(r) {
  return r.source === 'renter' ? 'renter' : 'normal';
}

// STEP 1 (4a): pilih API/akun cloud dulu (hanya yang punya server aktif), baru daftar
// server dari API itu — meniru pola menu Hapus VPS, tidak lagi membanjiri semua sekaligus.
async function showPowerServiceList(bot, chatId, messageId, page = 0) {
  if (!isAdmin(chatId)) return;
  const rows = (await vpsManager.listAllActiveInstances()).filter(r => r.droplet_id);
  if (!rows.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '🔌 *TURN ON / TURN OFF VPS&RDP*\n\nTidak ada droplet aktif yang bisa di ON/OFF.', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin' }]] }
    });
  }

  // Hitung server per API (admin) + total server penyewa (renter). api_id renter merujuk
  // ke renter_do_api (ruang id berbeda) jadi dikelompokkan terpisah.
  const adminCount = new Map();
  let renterCount = 0;
  for (const r of rows) {
    if (r.source === 'renter') { renterCount++; continue; }
    const key = Number(r.api_id || 0);
    adminCount.set(key, (adminCount.get(key) || 0) + 1);
  }

  const apis = await vpsManager.listDoApis();
  const kb = [];
  for (const a of apis) {
    const cnt = adminCount.get(Number(a.id)) || 0;
    if (cnt <= 0) continue;
    const base = vpsManager.formatApiLabel ? vpsManager.formatApiLabel(a) : (a.email ? `${a.email} - API#${a.id}` : `API#${a.id}`);
    const label = (Number(a.status) === 1) ? base : `⛔ ${base} (DISABLED)`;
    kb.push([{ text: `${label} • ${cnt} server`, callback_data: `vps_power_api:${a.id}:0` }]);
  }
  const knownIds = new Set(apis.map(a => Number(a.id)));
  for (const [key, cnt] of adminCount.entries()) {
    if (key && !knownIds.has(key) && cnt > 0) kb.push([{ text: `API#${key} • ${cnt} server`, callback_data: `vps_power_api:${key}:0` }]);
  }
  if (renterCount > 0) kb.push([{ text: `👥 Server Penyewa (Renter) • ${renterCount} server`, callback_data: 'vps_power_api:renter:0' }]);
  kb.push([{ text: '« Kembali', callback_data: 'vps_admin' }]);

  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🔌 *TURN ON / TURN OFF VPS&RDP*\n\n1️⃣ Pilih API/akun cloud dulu, lalu daftar server dari API itu akan muncul:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

// STEP 2 (4a): daftar server milik satu API (atau kelompok penyewa). apiKey = id do_api atau 'renter'.
async function showPowerServiceListForApi(bot, chatId, messageId, apiKey, page = 0) {
  if (!isAdmin(chatId)) return;
  const isRenter = String(apiKey) === 'renter';
  const rows = (await vpsManager.listAllActiveInstances()).filter(r => {
    if (!r.droplet_id) return false;
    if (isRenter) return r.source === 'renter';
    return r.source !== 'renter' && Number(r.api_id) === Number(apiKey);
  });
  if (!rows.length) {
    return safeMessageEditor.editMessage(bot, chatId, messageId, '🔌 *TURN ON / TURN OFF VPS&RDP*\n\nTidak ada server aktif untuk pilihan ini.', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_power_menu' }]] }
    });
  }
  const perPage = 12;
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const items = rows.slice(safePage * perPage, safePage * perPage + perPage);
  const kb = items.map(r => {
    const type = (vpsManager.isRdpInstance(r) ? 'rdp' : 'vps').toUpperCase();
    const ip = r.ip ? (type === 'RDP' ? String(r.ip) + ':' + (r.rdp_port || 4443) : String(r.ip)) : 'DROP ' + r.droplet_id;
    const src = powerSourceForRow(r);
    return [{ text: type + ' ' + ip + ' | Buyer ' + (r.user_id || '-'), callback_data: 'vps_power_pick:' + src + ':' + r.id }];
  });
  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️ Prev', callback_data: 'vps_power_api:' + apiKey + ':' + (safePage - 1) });
  nav.push({ text: (safePage + 1) + '/' + totalPages, callback_data: 'noop' });
  if (safePage < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: 'vps_power_api:' + apiKey + ':' + (safePage + 1) });
  if (totalPages > 1) kb.push(nav);
  kb.push([{ text: '« Pilih API lain', callback_data: 'vps_admin_power_menu' }]);

  const header = isRenter ? '👥 Server Penyewa (Renter)' : ('API#' + apiKey);
  return safeMessageEditor.editMessage(bot, chatId, messageId,
    '🔌 *TURN ON / TURN OFF VPS&RDP*\n\n📂 ' + header + '\n2️⃣ Pilih server yang ingin dinyalakan/dimatikan:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: kb }
  });
}

async function showPowerActionMenu(bot, chatId, messageId, source, id) {
  if (!isAdmin(chatId)) return;
  const target = await vpsManager.getAdminPowerTarget(source, id);
  if (!target) return bot.sendMessage(chatId, '❌ Data VPS/RDP tidak ditemukan atau droplet ID kosong.');
  const type = (vpsManager.isRdpInstance(target) ? 'rdp' : 'vps').toUpperCase();
  const ip = target.ip ? (type === 'RDP' ? String(target.ip) + ':' + (target.rdp_port || 4443) : String(target.ip)) : '-';
  const apiInfo = target.api_id ? ('API#' + target.api_id + (target.email ? ' (' + target.email + ')' : '')) : '-';
  const text = '🔌 *TURN ON / TURN OFF ' + type + '*\n\n' +
    'IP: ' + ip + '\n' +
    'Droplet ID: ' + target.droplet_id + '\n' +
    'API dipakai: ' + apiInfo + '\n\n' +
    'Action ini hanya ON/OFF, bukan restart/delete.';
  return safeMessageEditor.editMessage(bot, chatId, messageId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '🟢 TURN ON', callback_data: 'vps_power_do:' + source + ':' + id + ':on' }],
      [{ text: '🔴 TURN OFF', callback_data: 'vps_power_do:' + source + ':' + id + ':off' }],
      [{ text: '« Kembali', callback_data: 'vps_admin_power_menu' }]
    ] }
  });
}

async function executePowerAction(bot, chatId, messageId, source, id, action) {
  if (!isAdmin(chatId)) return;
  const target = await vpsManager.getAdminPowerTarget(source, id);
  if (!target || !target.droplet_id) return bot.sendMessage(chatId, '❌ Data VPS/RDP tidak ditemukan atau droplet ID kosong.');
  if (!target.token) return bot.sendMessage(chatId, '❌ API asal VPS/RDP ini tidak ditemukan. TURN ON/OFF dibatalkan agar tidak salah pakai API lain.');
  const type = (vpsManager.isRdpInstance(target) ? 'rdp' : 'vps').toUpperCase();
  const ip = target.ip ? (type === 'RDP' ? String(target.ip) + ':' + (target.rdp_port || 4443) : String(target.ip)) : '-';
  const label = action === 'on' ? 'TURN ON' : 'TURN OFF';
  await safeMessageEditor.editMessage(bot, chatId, messageId, '⏳ Memproses ' + label + ' ' + type + '...\nIP: ' + ip + '\nDroplet ID: ' + target.droplet_id, {
    reply_markup: { inline_keyboard: [[{ text: '« Kembali', callback_data: 'vps_admin_power_menu' }]] }
  });
  const res = await powerDroplet(target.token, target.droplet_id, action);
  if (!res.ok) return bot.sendMessage(chatId, '❌ Gagal ' + label + ' ' + type + '.\nIP: ' + ip + '\nReason: ' + (res.error || 'Unknown error') + '\n\nBot hanya memakai API asal VPS/RDP ini, tidak memakai fallback API lain.');
  return bot.sendMessage(chatId, '✅ ' + label + ' ' + type + ' berhasil dikirim ke provider cloud.\nIP: ' + ip + '\nDroplet ID: ' + target.droplet_id + '\n\nTunggu beberapa saat sampai status droplet berubah.', {
    reply_markup: { inline_keyboard: [[{ text: '🔌 Menu ON/OFF', callback_data: 'vps_admin_power_menu' }], [{ text: '🏠 VPS Admin', callback_data: 'vps_admin' }]] }
  });
}

module.exports = {
  showVpsAdminMenu,
  showDisableApiMenu,
  showDelApiMenu,
  disableApi,
  deleteApi,
  pickApiForAddProduct,
  pickSizeMenu,
  showDelVpsByApiMenu,
  showVpsListForDelete,
  showProviderFilterMenu,
  pickProviderForAddProduct,
  showStockTypeMenu,
  showStockGroupMenu,
  showStockApiMenu,
  showPriceTypeMenu,
  showPriceSpecMenu,
  showInstallPriceMenu,
  showAdminServiceList,
  showAdminServiceListByApi,
  showAdminBackupServiceList,
  showDoStatusMenu,
  showDoStatus,
  showAllDoStatus,
  showPowerServiceList,
  showPowerServiceListForApi,
  showPowerActionMenu,
  executePowerAction
};
