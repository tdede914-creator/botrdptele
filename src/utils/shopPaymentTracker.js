const db = require('../config/database');
const { getUser } = require('./userManager');

class ShopPaymentTracker {
  static async initTable() {
    // Tables are created in config/database.js, but keep this for safety on old DBs.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS shop_pending_payments (
        unique_code TEXT PRIMARY KEY,
        transaction_id TEXT,
        user_id INTEGER,
        order_id INTEGER,
        amount INTEGER,
        expiry_time INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  static async addPendingPayment(userId, transactionId, uniqueCode, orderId, amount, expiryTime) {
    await this.initTable();
    await getUser(userId);
    // one pending shop payment per user
    await db.run('DELETE FROM shop_pending_payments WHERE user_id = ?', [userId]);
    await db.run(
      'INSERT INTO shop_pending_payments (unique_code, transaction_id, user_id, order_id, amount, expiry_time) VALUES (?, ?, ?, ?, ?, ?)',
      [uniqueCode, transactionId, userId, orderId, amount, expiryTime]
    );
  }

  static async getPendingPayment(userId) {
    await this.initTable();
    return await db.get(
      'SELECT * FROM shop_pending_payments WHERE user_id = ? AND expiry_time > ? ORDER BY created_at DESC LIMIT 1',
      [userId, Date.now()]
    );
  }

  static async getPendingByOrder(orderId) {
    await this.initTable();
    return await db.get(
      'SELECT * FROM shop_pending_payments WHERE order_id = ? AND expiry_time > ? ORDER BY created_at DESC LIMIT 1',
      [orderId, Date.now()]
    );
  }

  static async removePendingPayment(transactionId) {
    await this.initTable();
    await db.run('DELETE FROM shop_pending_payments WHERE transaction_id = ?', [transactionId]);
  }

  static async cleanupExpiredPayments() {
    await this.initTable();
    const now = Date.now();
    const expired = await db.all('SELECT order_id FROM shop_pending_payments WHERE expiry_time <= ?', [now]);
    for (const row of expired || []) {
      if (!row.order_id) continue;
      await db.run(
        `UPDATE shop_stock_items
         SET reserved_by_order_id = NULL, reserved_until = NULL
         WHERE is_sold = 0 AND reserved_by_order_id = ?`,
        [row.order_id]
      );
      await db.run(
        `UPDATE shop_orders
         SET status = ?
         WHERE id = ? AND status IN ('pending_payment','creating_payment')`,
        ['expired', row.order_id]
      );
    }
    const result = await db.run('DELETE FROM shop_pending_payments WHERE expiry_time <= ?', [now]);
    return result.changes || 0;
  }
}

module.exports = ShopPaymentTracker;
