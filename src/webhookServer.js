require('dotenv').config();
const http = require('http');
const PaymentTracker = require('./utils/paymentTracker');
const BalanceManager = require('./handlers/balanceHandler');

const PORT = Number(process.env.DOMPETX_WEBHOOK_PORT || 3000);
const PATHNAME = process.env.DOMPETX_WEBHOOK_PATH || '/dompetx/webhook';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function pick(obj, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let cur = obj;
    for (const part of parts) {
      cur = cur && cur[part] !== undefined ? cur[part] : undefined;
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

function isPaidStatus(status) {
  return ['paid', 'success', 'completed', 'settlement', 'capture'].includes(String(status || '').toLowerCase());
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('DompetX webhook aktif');
  }

  if (req.method !== 'POST' || !req.url.startsWith(PATHNAME)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, message: 'Not found' }));
  }

  try {
    const payload = await readJson(req);
    console.log('DompetX webhook payload:', JSON.stringify(payload, null, 2));

    const transactionId = pick(payload, ['id', 'paymentId', 'payment_id', 'reference', 'data.id', 'data.reference']);
    const status = pick(payload, ['status', 'payment_status', 'transaction_status', 'data.status']);
    const amount = Number(pick(payload, ['getBalance', 'amount', 'totalAmount', 'data.getBalance', 'data.amount', 'data.totalAmount']) || 0);

    if (transactionId && isPaidStatus(status)) {
      const pending = await PaymentTracker.findPendingPaymentByTransactionOrCode(transactionId);
      if (pending) {
        await BalanceManager.updateBalance(pending.user_id, amount || pending.amount);
        await PaymentTracker.removePendingPayment(pending.transaction_id);
        console.log(`Webhook applied payment for user ${pending.user_id} / transaction ${pending.transaction_id}`);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  } catch (error) {
    console.error('DompetX webhook error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, message: error.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`DompetX webhook server running at http://127.0.0.1:${PORT}${PATHNAME}`);
});
