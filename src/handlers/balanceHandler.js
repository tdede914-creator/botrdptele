const db = require('../config/database');

class BalanceManager {
  // Get current user balance
  static async getUserBalance(userId) {
    try {
      const row = await db.get(
        'SELECT balance FROM users WHERE telegram_id = ?',
        [userId]
      );
      return row ? row.balance : 0;
    } catch (error) {
      console.error('Error getting user balance:', error);
      throw error;
    }
  }

  // Update user balance with transaction handling
  static async updateBalance(userId, amount) {
    try {
      // Start transaction
      await db.run('BEGIN TRANSACTION');

      // Get current balance
      const currentBalance = await this.getUserBalance(userId);
      const newBalance = currentBalance + amount;

      // Update user balance
      await db.run(
        'UPDATE users SET balance = ? WHERE telegram_id = ?',
        [newBalance, userId]
      );

      // Log the transaction
      await db.run(
        'INSERT INTO transactions (user_id, amount, type) VALUES (?, ?, ?)',
        [userId, amount, amount > 0 ? 'deposit' : 'deduct']
      );

      // Commit transaction
      await db.run('COMMIT');

      return newBalance;
    } catch (error) {
      // Rollback on error
      await db.run('ROLLBACK');
      console.error('Error updating balance:', error);
      throw error;
    }
  }

  // Get transaction history for a user
  static async getTransactionHistory(userId, limit = 10) {
    try {
      const transactions = await db.all(
        `SELECT * FROM transactions 
         WHERE user_id = ? 
         ORDER BY created_at DESC 
         LIMIT ?`,
        [userId, limit]
      );
      return transactions;
    } catch (error) {
      console.error('Error getting transaction history:', error);
      throw error;
    }
  }

  // Verify balance consistency
  static async verifyBalance(userId) {
    try {
      const transactions = await db.all(
        'SELECT SUM(amount) as total FROM transactions WHERE user_id = ?',
        [userId]
      );
      const currentBalance = await this.getUserBalance(userId);
      const calculatedBalance = transactions[0].total || 0;

      if (currentBalance !== calculatedBalance) {
        console.error(`Balance mismatch for user ${userId}:`, {
          stored: currentBalance,
          calculated: calculatedBalance
        });
        // Fix the balance
        await db.run(
          'UPDATE users SET balance = ? WHERE telegram_id = ?',
          [calculatedBalance, userId]
        );
      }

      return calculatedBalance;
    } catch (error) {
      console.error('Error verifying balance:', error);
      throw error;
    }
  }
}

module.exports = BalanceManager;