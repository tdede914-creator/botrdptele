const db = require('../config/database');
const { getUser } = require('./userManager');

class PaymentTracker {
  static async initTable() {
    try {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS pending_payments (
          unique_code TEXT PRIMARY KEY,
          transaction_id TEXT,
          user_id INTEGER,
          amount INTEGER,
          expiry_time INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(telegram_id)
        )
      `);
    } catch (error) {
      console.error('Error initializing pending_payments table:', error);
      throw error;
    }
  }

  static async addPendingPayment(userId, transactionId, uniqueCode, amount, expiryTime) {
    try {
      await this.initTable();
      await getUser(userId);
      await db.run('DELETE FROM pending_payments WHERE user_id = ?', [userId]);
      await db.run(
        'INSERT INTO pending_payments (unique_code, transaction_id, user_id, amount, expiry_time) VALUES (?, ?, ?, ?, ?)',
        [uniqueCode, transactionId, userId, amount, expiryTime]
      );
    } catch (error) {
      console.error('Error adding pending payment:', error);
      throw error;
    }
  }

  static async getPendingPayment(userId) {
    try {
      await this.initTable();
      const payment = await db.get(
        'SELECT * FROM pending_payments WHERE user_id = ? AND expiry_time > ? ORDER BY created_at DESC LIMIT 1',
        [userId, Date.now()]
      );
      return payment;
    } catch (error) {
      console.error('Error getting pending payment:', error);
      throw error;
    }
  }


  static async findPendingPaymentByTransactionOrCode(value) {
    try {
      await this.initTable();
      const payment = await db.get(
        'SELECT * FROM pending_payments WHERE (transaction_id = ? OR unique_code = ?) AND expiry_time > ? ORDER BY created_at DESC LIMIT 1',
        [value, value, Date.now()]
      );
      return payment || null;
    } catch (error) {
      console.error('Error finding pending payment by transaction/code:', error);
      throw error;
    }
  }

  static async removePendingPayment(transactionId) {
    try {
      await db.run('DELETE FROM pending_payments WHERE transaction_id = ?', [transactionId]);
    } catch (error) {
      console.error('Error removing pending payment:', error);
      throw error;
    }
  }

  static async cleanupExpiredPayments() {
    try {
      await this.initTable();
      const result = await db.run('DELETE FROM pending_payments WHERE expiry_time <= ?', [Date.now()]);
      if (result.changes > 0) {
        console.log(`Cleaned up ${result.changes} expired payments`);
      }
    } catch (error) {
      console.error('Error cleaning up expired payments:', error);
    }
  }
}

module.exports = PaymentTracker;