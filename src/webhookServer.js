require('dotenv').config();
const http = require('http');
const PaymentTracker = require('./utils/paymentTracker');
const BalanceManager = require('./handlers/balanceHandler');

// PORT: pakai WEBHOOK_PORT (baru, generic) atau fallback ke DOMPETX_WEBHOOK_PORT (lama)
const PORT = Number(process.env.WEBHOOK_PORT || process.env.DOMPETX_WEBHOOK_PORT || 3000);
const DOMPETX_PATH = process.env.DOMPETX_WEBHOOK_PATH || '/dompetx/webhook';
const OKU_PATH = process.env.ORDERKUOTA_WEBHOOK_PATH || '/orderkuota/webhook';

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body || ''));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
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
  return ['paid', 'success', 'completed', 'settlement', 'capture'].includes(
    String(status || '').toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// Handler: DompetX webhook (existing behavior, tidak diubah)
// ---------------------------------------------------------------------------
async function handleDompetXWebhook(req, res) {
  try {
    const raw = await readRaw(req);
    const payload = parseJson(raw);
    if (payload === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'invalid json' }));
    }
    console.log('DompetX webhook payload:', JSON.stringify(payload, null, 2));

    const transactionId = pick(payload, [
      'id', 'paymentId', 'payment_id', 'reference',
      'data.id', 'data.reference',
    ]);
    const status = pick(payload, [
      'status', 'payment_status', 'transaction_status', 'data.status',
    ]);
    const amount = Number(
      pick(payload, [
        'getBalance', 'amount', 'totalAmount',
        'data.getBalance', 'data.amount', 'data.totalAmount',
      ]) || 0,
    );

    if (transactionId && isPaidStatus(status)) {
      const pending = await PaymentTracker.findPendingPaymentByTransactionOrCode(transactionId);
      if (pending) {
        await BalanceManager.updateBalance(pending.user_id, amount || pending.amount);
        await PaymentTracker.removePendingPayment(pending.transaction_id);
        console.log(`[dompetx] applied payment for user ${pending.user_id} / trx ${pending.transaction_id}`);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (error) {
    console.error('DompetX webhook error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: error.message }));
  }
}

// ---------------------------------------------------------------------------
// Handler: OrderKuota (PG-Donn-) webhook
// ---------------------------------------------------------------------------
// Body yang dikirim PG-Donn- saat invoice PAID:
//   {
//     "event": "invoice.paid",
//     "reference": "INV-XXX",
//     "merchantRef": "DEP<ts><chatId>" | "ORD<ts><chatId>" | "RENT<ts><chatId>",
//     "amount": 15000,
//     "uniqueCode": 342,
//     "totalAmount": 15342,
//     "status": "PAID",
//     "paidAt": "...",
//     "providerType": "orderkuota_jywa"
//   }
// Header: X-Signature: HMAC-SHA256(rawBody, apiKey.secret)
//
// Deposit di-complete inline; shop/renter cuma di-log dan dibiarkan
// polling `shopPaymentStatus` / `renterHandler.refreshRentPayment` yang
// menyelesaikan flow (karena business logic-nya kompleks).
// ---------------------------------------------------------------------------
async function handleOrderkuotaWebhook(req, res) {
  try {
    const raw = await readRaw(req);
    const signature = req.headers['x-signature'] || '';

    const oku = require('./utils/orderkuotaGateway');
    if (!oku.verifyWebhookSignature(raw, signature)) {
      console.warn('[orderkuota webhook] signature INVALID — request ditolak.');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'invalid signature' }));
    }

    const payload = parseJson(raw);
    if (payload === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, message: 'invalid json' }));
    }

    console.log('OrderKuota webhook payload:', JSON.stringify(payload, null, 2));

    const event = String(payload.event || '').toLowerCase();
    const status = String(payload.status || '').toLowerCase();
    if (event !== 'invoice.paid' && status !== 'paid') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, ignored: true }));
    }

    const reference = payload.reference;
    const merchantRef = payload.merchantRef;
    const amount = Number(payload.amount || 0);
    if (!reference) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, ignored: 'no reference' }));
    }

    const db = require('./config/database');

    // 1) Deposit — kredit saldo user langsung
    let pending = await PaymentTracker.findPendingPaymentByTransactionOrCode(reference);
    if (!pending && merchantRef) {
      pending = await PaymentTracker.findPendingPaymentByTransactionOrCode(merchantRef);
    }
    if (pending) {
      await BalanceManager.updateBalance(pending.user_id, amount || pending.amount);
      await PaymentTracker.removePendingPayment(pending.transaction_id);
      console.log(
        `[orderkuota] DEPOSIT paid: user=${pending.user_id} ref=${reference} amount=${amount || pending.amount}`,
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, source: 'deposit' }));
    }

    // 2) Shop order — log, biarkan polling shopPaymentStatus finalize
    try {
      const shopRow = await db.get(
        `SELECT * FROM shop_pending_payments
         WHERE transaction_id = ? OR unique_code = ?
         ORDER BY created_at DESC LIMIT 1`,
        [reference, merchantRef || reference],
      );
      if (shopRow) {
        console.log(
          `[orderkuota] SHOP paid: user=${shopRow.user_id} order=${shopRow.order_id} ref=${reference} — polling will finalize.`,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, source: 'shop', mode: 'polling-finalize' }));
      }
    } catch (e) {
      console.log('[orderkuota] shop lookup skipped:', e.message);
    }

    // 3) Renter subscription — log, biarkan polling renterHandler finalize
    try {
      const renterRow = await db.get(
        `SELECT * FROM renter_pending_payments
         WHERE transaction_id = ? OR unique_code = ?
         ORDER BY created_at DESC LIMIT 1`,
        [reference, merchantRef || reference],
      );
      if (renterRow) {
        console.log(
          `[orderkuota] RENTER paid: user=${renterRow.user_id} plan=${renterRow.plan}/${renterRow.days}d ref=${reference} — polling will finalize.`,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true, source: 'renter', mode: 'polling-finalize' }));
      }
    } catch (e) {
      console.log('[orderkuota] renter lookup skipped:', e.message);
    }

    console.log(
      `[orderkuota] no matching pending in deposit/shop/renter for ref=${reference} merchantRef=${merchantRef || '(none)'} — safe to ignore if this is a duplicate or expired invoice.`,
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, ignored: 'no matching pending' }));
  } catch (error) {
    console.error('OrderKuota webhook error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: error.message }));
  }
}

// ---------------------------------------------------------------------------
// HTTP router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(
      `Webhook server aktif.\n\n` +
      `Endpoints:\n` +
      `  POST ${DOMPETX_PATH}\n` +
      `  POST ${OKU_PATH}\n`,
    );
  }

  if (req.method === 'POST' && req.url.startsWith(OKU_PATH)) {
    return handleOrderkuotaWebhook(req, res);
  }

  if (req.method === 'POST' && req.url.startsWith(DOMPETX_PATH)) {
    return handleDompetXWebhook(req, res);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, message: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Webhook server running at :${PORT}`);
  console.log(`  DompetX    -> POST ${DOMPETX_PATH}`);
  console.log(`  OrderKuota -> POST ${OKU_PATH}`);
});
