from pathlib import Path
p=Path('src/utils/doApi.js')
s=p.read_text()
insert = r'''
async function getDropletsCount(token) {
  try {
    let page = 1;
    let total = null;
    let counted = 0;
    while (true) {
      const r = await axios.get(`${DO_API}/droplets?page=${page}&per_page=200`, { headers: headers(token), timeout: 30000 });
      const droplets = Array.isArray(r.data?.droplets) ? r.data.droplets : [];
      counted += droplets.length;
      if (r.data?.meta && typeof r.data.meta.total === 'number') total = r.data.meta.total;
      const links = r.data?.links?.pages;
      if (links && links.next) {
        page += 1;
        continue;
      }
      break;
    }
    return { ok: true, count: total !== null ? total : counted, error: null };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.message || err.message || 'Unknown error';
    return { ok: false, count: null, error: status ? `HTTP ${status}: ${msg}` : msg };
  }
}

async function getBillingHistory(token) {
  try {
    const entries = [];
    let page = 1;
    while (page <= 3) {
      const r = await axios.get(`${DO_API}/customers/my/billing_history?page=${page}&per_page=200`, { headers: headers(token), timeout: 30000 });
      const rows = Array.isArray(r.data?.billing_history) ? r.data.billing_history : [];
      entries.push(...rows);
      const links = r.data?.links?.pages;
      if (links && links.next) {
        page += 1;
        continue;
      }
      break;
    }
    return { ok: true, entries, error: null };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const msg = data?.message || err.message || 'Unknown error';
    return { ok: false, entries: [], error: status ? `HTTP ${status}: ${msg}` : msg };
  }
}

function numberFromMoney(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function summarizeCreditsFromHistory(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  let detectedTotal = 0;
  const creditRows = [];
  for (const row of rows) {
    const desc = String(row.description || row.name || row.type || row.invoice_id || '').trim();
    const hay = `${desc} ${row.amount || ''} ${row.balance || ''}`.toLowerCase();
    const isCredit = /credit|promo|promotional|github|student|coupon|trial|adjustment/.test(hay);
    if (!isCredit) continue;
    const amount = numberFromMoney(row.amount ?? row.credit ?? row.total ?? row.balance);
    if (amount) detectedTotal += Math.abs(amount);
    creditRows.push({
      date: row.date || row.invoice_period || row.created_at || '-',
      description: desc || 'Credit / adjustment',
      amount: amount || null
    });
  }
  return { detectedTotal, rows: creditRows.slice(0, 5) };
}
'''
# insert before classifyAccountStatus
s=s.replace('\nfunction classifyAccountStatus(accountResult) {', insert+'\nfunction classifyAccountStatus(accountResult) {')
old = """async function getAccountHealth(token) {\n  const [accountResult, balanceResult] = await Promise.all([\n    getAccountInfo(token),\n    getCustomerBalance(token)\n  ]);\n  return {\n    ok: accountResult.ok,\n    status: classifyAccountStatus(accountResult),\n    account: accountResult.account,\n    balance: balanceResult.balance,\n    accountError: accountResult.error,\n    balanceError: balanceResult.error,\n    accountStatusCode: accountResult.statusCode,\n    balanceStatusCode: balanceResult.statusCode\n  };\n}\n"""
new = """async function getAccountHealth(token) {\n  const [accountResult, balanceResult, dropletsResult, historyResult] = await Promise.all([\n    getAccountInfo(token),\n    getCustomerBalance(token),\n    getDropletsCount(token),\n    getBillingHistory(token)\n  ]);\n  const creditSummary = summarizeCreditsFromHistory(historyResult.entries);\n  return {\n    ok: accountResult.ok,\n    status: classifyAccountStatus(accountResult),\n    account: accountResult.account,\n    balance: balanceResult.balance,\n    dropletCount: dropletsResult.count,\n    creditSummary,\n    accountError: accountResult.error,\n    balanceError: balanceResult.error,\n    dropletsError: dropletsResult.error,\n    billingHistoryError: historyResult.error,\n    accountStatusCode: accountResult.statusCode,\n    balanceStatusCode: balanceResult.statusCode\n  };\n}\n"""
if old not in s:
    raise SystemExit('old getAccountHealth not found')
s=s.replace(old,new)
s=s.replace('  getCustomerBalance,\n  getAccountHealth\n};','  getCustomerBalance,\n  getDropletsCount,\n  getBillingHistory,\n  getAccountHealth\n};')
p.write_text(s)

p=Path('src/handlers/vpsAdminHandler.js')
s=p.read_text()
# replace detail text section
old = """  const creditLimit = formatUsdValue(balance.account_balance);\n  const monthToDate = formatUsdValue(balance.month_to_date_balance);\n  const generatedAt = balance.generated_at ? String(balance.generated_at) : '-';\n  let text = '🔍 STATUS AKUN DIGITALOCEAN\\n\\n';\n  text += `API: API#${apiRow.id}\\n`;\n  text += `Email: ${email}\\n`;\n  text += `Status: ${accountStatusEmoji(status)} ${status}\\n`;\n  text += `Email Verified: ${emailVerified}\\n`;\n  text += `UUID: ${uuid}\\n\\n`;\n  text += `💳 Billing/Credit\\n`;\n  text += `Sisa / Balance: ${creditLimit}\\n`;\n  text += `Pemakaian bulan ini: ${monthToDate}\\n`;\n  text += `Update billing: ${generatedAt}\\n\\n`;\n  text += `📦 Limit\\n`;\n  text += `Droplet limit: ${dropletLimit}\\n`;\n  text += `Floating IP limit: ${floatingIpLimit}\\n`;\n  if (info.accountError) text += `\\nAccount API Error: ${info.accountError}`;\n  if (info.balanceError) text += `\\nBilling API Error: ${info.balanceError}`;\n  return text;\n}\n"""
new = """  const creditLimit = formatUsdValue(balance.account_balance);\n  const monthToDate = formatUsdValue(balance.month_to_date_balance);\n  const generatedAt = balance.generated_at ? String(balance.generated_at) : '-';\n  const dropletCount = info.dropletCount === null || info.dropletCount === undefined ? '-' : info.dropletCount;\n  const creditSummary = info.creditSummary || { detectedTotal: 0, rows: [] };\n  let text = '🔍 STATUS AKUN DIGITALOCEAN\\n\\n';\n  text += `API: API#${apiRow.id}\\n`;\n  text += `Email: ${email}\\n`;\n  text += `Status: ${accountStatusEmoji(status)} ${status}\\n`;\n  text += `Email Verified: ${emailVerified}\\n`;\n  text += `UUID: ${uuid}\\n\\n`;\n  text += `💳 Billing/Credit\\n`;\n  text += `Balance/tagihan API: ${creditLimit}\\n`;\n  text += `Pemakaian bulan ini: ${monthToDate}\\n`;\n  text += `Promo/Credit terdeteksi: ${creditSummary.detectedTotal ? formatUsdValue(creditSummary.detectedTotal) : '-'}\\n`;\n  if (creditSummary.rows && creditSummary.rows.length) {\n    text += `Riwayat credit terbaru:\\n`;\n    for (const row of creditSummary.rows) {\n      const amt = row.amount === null || row.amount === undefined ? '-' : formatUsdValue(row.amount);\n      text += `• ${row.date} - ${amt} - ${row.description}\\n`;\n    }\n  }\n  text += `Update billing: ${generatedAt}\\n\\n`;\n  text += `📦 Droplet/Limit\\n`;\n  text += `Jumlah droplet terpakai: ${dropletCount}\\n`;\n  text += `Droplet limit: ${dropletLimit}\\n`;\n  text += `Floating IP limit: ${floatingIpLimit}\\n`;\n  if (info.accountError) text += `\\nAccount API Error: ${info.accountError}`;\n  if (info.balanceError) text += `\\nBilling API Error: ${info.balanceError}`;\n  if (info.billingHistoryError) text += `\\nBilling History API Error: ${info.billingHistoryError}`;\n  if (info.dropletsError) text += `\\nDroplet API Error: ${info.dropletsError}`;\n  return text;\n}\n"""
if old not in s:
    raise SystemExit('detail block not found')
s=s.replace(old,new)
old = """    lines.push(`${accountStatusEmoji(info.status)} API#${api.id} • ${email}`);\n    lines.push(`Status: ${info.status || 'UNKNOWN'} • Balance: ${formatUsdValue(balance.account_balance)} • MTD: ${formatUsdValue(balance.month_to_date_balance)}`);\n    if (info.accountError) lines.push(`Error: ${info.accountError}`);\n"""
new = """    const creditSummary = info.creditSummary || { detectedTotal: 0 };\n    const dropletCount = info.dropletCount === null || info.dropletCount === undefined ? '-' : info.dropletCount;\n    lines.push(`${accountStatusEmoji(info.status)} API#${api.id} • ${email}`);\n    lines.push(`Status: ${info.status || 'UNKNOWN'} • Droplet: ${dropletCount} • Balance: ${formatUsdValue(balance.account_balance)} • MTD: ${formatUsdValue(balance.month_to_date_balance)} • Credit: ${creditSummary.detectedTotal ? formatUsdValue(creditSummary.detectedTotal) : '-'}`);\n    if (info.accountError) lines.push(`Error: ${info.accountError}`);\n    if (info.billingHistoryError) lines.push(`Billing history: ${info.billingHistoryError}`);\n    if (info.dropletsError) lines.push(`Droplet count: ${info.dropletsError}`);\n"""
if old not in s:
    raise SystemExit('summary block not found')
s=s.replace(old,new)
p.write_text(s)
