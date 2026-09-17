const db = require('../config/database');
const BalanceManager = require('../handlers/balanceHandler');

async function getUser(userId) {
  try {
    let user = await db.get('SELECT * FROM users WHERE telegram_id = ?', [userId]);
    
    if (!user) {
      await db.run(
        'INSERT INTO users (telegram_id, balance) VALUES (?, 0)',
        [userId]
      );
      user = {
        telegram_id: userId,
        balance: 0,
        created_at: new Date().toISOString()
      };
    }
    
    return user;
  } catch (error) {
    console.error('Error getting user:', error);
    throw error;
  }
}

async function getAllUsers() {
  try {
    return await db.all('SELECT * FROM users');
  } catch (error) {
    console.error('Error getting all users:', error);
    throw error;
  }
}

function isAdmin(userId) {
  return userId.toString() === process.env.ADMIN_ID;
}

async function addBalance(userId, amount) {
  try {
    // Ensure user exists
    await getUser(userId);
    
    // Use BalanceManager to handle the balance update
    const newBalance = await BalanceManager.updateBalance(userId, amount);
    
    // Verify balance consistency
    await BalanceManager.verifyBalance(userId);
    
    return newBalance;
  } catch (error) {
    console.error('Error adding balance:', error);
    throw error;
  }
}

async function deductBalance(userId, amount) {
  if (isAdmin(userId)) return true;
  
  try {
    // Verify balance before deduction
    const verifiedBalance = await BalanceManager.verifyBalance(userId);
    
    if (verifiedBalance >= amount) {
      const newBalance = await BalanceManager.updateBalance(userId, -amount);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deducting balance:', error);
    throw error;
  }
}

async function getBalance(userId) {
  if (isAdmin(userId)) return "Unlimited";
  
  try {
    // Get verified balance
    const balance = await BalanceManager.verifyBalance(userId);
    return balance;
  } catch (error) {
    console.error('Error getting balance:', error);
    throw error;
  }
}

module.exports = {
  getUser,
  getAllUsers,
  isAdmin,
  addBalance,
  deductBalance,
  getBalance
};