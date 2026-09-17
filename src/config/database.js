const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create database connection
const db = new sqlite3.Database(path.join(__dirname, '../rdp.db'), (err) => {
    if (err) {
        console.error('Error connecting to database:', err);
        process.exit(1);
    }
    console.log('Connected to SQLite database');
});

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');

// Promisify database methods for easier async/await usage
const dbAsync = {
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, changes: this.changes });
            });
        });
    },

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    },

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    },

    exec(sql) {
        return new Promise((resolve, reject) => {
            db.exec(sql, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
};

// Initialize database tables
async function initDatabase() {
    try {
        // Create users table if not exists
        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS users (
                telegram_id INTEGER PRIMARY KEY,
                balance REAL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create transactions table if not exists
        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                type TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(telegram_id)
            )
        `);

        // Create pending_payments table for payment tracking
        await dbAsync.exec(`
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

        // ================= Auto Order / Shop Tables =================
        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS shop_products (
                code TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                price INTEGER NOT NULL DEFAULT 0,
                description TEXT DEFAULT ''
            )
        `);

        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS shop_stock_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_code TEXT NOT NULL,
                email TEXT NOT NULL,
                password TEXT NOT NULL,
                twofa TEXT,
                note TEXT,
                extra TEXT,
                is_sold INTEGER NOT NULL DEFAULT 0,
                reserved_by_order_id INTEGER,
                reserved_until INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (product_code) REFERENCES shop_products(code)
            )
        `);

        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS shop_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                chat_id INTEGER,
                product_code TEXT NOT NULL,
                qty INTEGER NOT NULL,
                amount INTEGER NOT NULL,
                admin_fee INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expire_at TEXT NOT NULL,
                payment_ref TEXT,
                trx_id TEXT,
                qris_string TEXT,
                qris_image TEXT,
                qr_msg_id INTEGER,
                FOREIGN KEY (product_code) REFERENCES shop_products(code)
            )
        `);

        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS shop_pending_payments (
                unique_code TEXT PRIMARY KEY,
                transaction_id TEXT,
                user_id INTEGER,
                order_id INTEGER,
                amount INTEGER,
                expiry_time INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(telegram_id),
                FOREIGN KEY (order_id) REFERENCES shop_orders(id)
            )
        `);

        // Migration for older shop databases: add reservation columns to prevent race condition.
        try {
            const stockCols = await dbAsync.all('PRAGMA table_info(shop_stock_items)');
            const hasReservedBy = Array.isArray(stockCols) && stockCols.some(c => c.name === 'reserved_by_order_id');
            const hasReservedUntil = Array.isArray(stockCols) && stockCols.some(c => c.name === 'reserved_until');
            if (!hasReservedBy) {
                await dbAsync.exec('ALTER TABLE shop_stock_items ADD COLUMN reserved_by_order_id INTEGER');
            }
            if (!hasReservedUntil) {
                await dbAsync.exec('ALTER TABLE shop_stock_items ADD COLUMN reserved_until INTEGER');
            }
            await dbAsync.exec('UPDATE shop_stock_items SET reserved_by_order_id = NULL, reserved_until = NULL WHERE is_sold = 0 AND reserved_until IS NOT NULL AND reserved_until <= ' + Date.now());
        } catch (e) {
            console.warn('⚠️  Could not run shop stock reservation migration:', e?.message || e);
        }

        // Create rdp_installations table for RDP tracking
        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS rdp_installations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                ip_address TEXT NOT NULL,
                hostname TEXT,
                os_type TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP NULL,
                FOREIGN KEY (user_id) REFERENCES users(telegram_id)
            )
        `);

        // Create admin_settings table for admin configurations
	    await dbAsync.exec(`
	        CREATE TABLE IF NOT EXISTS admin_settings (
	            key TEXT PRIMARY KEY,
	            value TEXT NOT NULL,
	            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	        )
	    `);

        // ================= Crypto Deposits (Binance Pay ID + USDT BEP20) =================
        // Tracks every crypto deposit attempt. The unique (method, tx_ref) constraint
        // prevents a user from claiming the same transaction twice. `status` is
        // 'pending' while waiting for Binance API confirmation, 'success' once
        // credited to balance, and 'failed'/'rejected' for TX-IDs that never
        // resolved or were flagged (wrong network, duplicate, etc).
        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS crypto_deposits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                method TEXT NOT NULL,
                tx_ref TEXT NOT NULL,
                network TEXT,
                amount_usdt REAL,
                exchange_rate REAL,
                amount_idr INTEGER,
                fee_percentage REAL,
                fee_flat_idr INTEGER,
                fee_total_idr INTEGER,
                net_credit_idr INTEGER,
                status TEXT NOT NULL,
                binance_response TEXT,
                reject_reason TEXT,
                created_at INTEGER NOT NULL,
                processed_at INTEGER,
                UNIQUE(method, tx_ref),
                FOREIGN KEY (user_id) REFERENCES users(telegram_id)
            )
        `);
        // Indexes: fast lookup for admin listings and user history.
        await dbAsync.exec(`
            CREATE INDEX IF NOT EXISTS idx_crypto_deposits_user_id ON crypto_deposits(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_crypto_deposits_status ON crypto_deposits(status, created_at DESC);
        `);

	    // ================= VPS (DigitalOcean) Tables =================
	    await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS do_api (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL,
                email TEXT,
                status INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Store DigitalOcean account health (suspend/locked/verify) to avoid duplicate notifications
        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS do_api_health (
                api_id INTEGER PRIMARY KEY,
                state TEXT NOT NULL DEFAULT 'ok',
                last_error TEXT,
                last_checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_notified_at TIMESTAMP NULL,
                FOREIGN KEY (api_id) REFERENCES do_api(id) ON DELETE CASCADE
            )
        `);

        // Migration for older databases: add email column if missing
        try {
            const cols = await dbAsync.all('PRAGMA table_info(do_api)');
            const hasEmail = Array.isArray(cols) && cols.some(c => c.name === 'email');
            if (!hasEmail) {
                await dbAsync.exec('ALTER TABLE do_api ADD COLUMN email TEXT');
            }
        } catch (e) {
            console.warn('⚠️  Could not run do_api migration:', e?.message || e);
        }

		        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS vps_products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                api_id INTEGER NOT NULL,
                product_type TEXT NOT NULL DEFAULT 'vps',
                size_slug TEXT NOT NULL,
                ram INTEGER,
                core INTEGER,
                price INTEGER NOT NULL,             -- bulanan
                price_daily INTEGER NULL,
                price_weekly INTEGER NULL,
                slot INTEGER DEFAULT 0,             -- legacy total slot (kept for backward compatibility)
                slot_daily INTEGER DEFAULT 0,
                slot_weekly INTEGER DEFAULT 0,
                slot_monthly INTEGER DEFAULT 0,
                status INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (api_id) REFERENCES do_api(id) ON DELETE CASCADE
            )
	`);

        // Migration for older databases: add product_type column if missing
        try {
            const cols = await dbAsync.all('PRAGMA table_info(vps_products)');
            const hasType = Array.isArray(cols) && cols.some(c => c.name === 'product_type');
            if (!hasType) {
                await dbAsync.exec("ALTER TABLE vps_products ADD COLUMN product_type TEXT NOT NULL DEFAULT 'vps'");
            }
        } catch (e) {
            console.warn('⚠️  Could not run vps_products migration:', e?.message || e);
        }
// Migration for older databases: add price_daily and price_weekly columns if missing
        try {
            const cols = await dbAsync.all('PRAGMA table_info(vps_products)');
            const hasDaily = Array.isArray(cols) && cols.some(c => c.name === 'price_daily');
            const hasWeekly = Array.isArray(cols) && cols.some(c => c.name === 'price_weekly');
            if (!hasDaily) {
                await dbAsync.exec('ALTER TABLE vps_products ADD COLUMN price_daily INTEGER NULL');
            }
            if (!hasWeekly) {
                await dbAsync.exec('ALTER TABLE vps_products ADD COLUMN price_weekly INTEGER NULL');
            }
            // NOTE: We keep legacy column `price` as BULANAN. Do NOT auto-backfill weekly from `price`.
            // Admin can set price_weekly manually via panel.

        } catch (e) {
            console.warn('⚠️  Could not run vps_products price migration:', e?.message || e);
        }

        // Migration: per-duration stock columns
        try {
            const cols = await dbAsync.all('PRAGMA table_info(vps_products)');
            const hasSlotDaily = Array.isArray(cols) && cols.some(c => c.name === 'slot_daily');
            const hasSlotWeekly = Array.isArray(cols) && cols.some(c => c.name === 'slot_weekly');
            const hasSlotMonthly = Array.isArray(cols) && cols.some(c => c.name === 'slot_monthly');

            // Only run legacy backfill when we *just added* the per-duration columns.
            const addedDurationColumns = (!hasSlotDaily) || (!hasSlotWeekly) || (!hasSlotMonthly);

            if (!hasSlotDaily) await dbAsync.exec('ALTER TABLE vps_products ADD COLUMN slot_daily INTEGER DEFAULT 0');
            if (!hasSlotWeekly) await dbAsync.exec('ALTER TABLE vps_products ADD COLUMN slot_weekly INTEGER DEFAULT 0');
            if (!hasSlotMonthly) await dbAsync.exec('ALTER TABLE vps_products ADD COLUMN slot_monthly INTEGER DEFAULT 0');

            if (addedDurationColumns) {
            // Backfill: older DBs only had `slot`. Assume that stock applies to all durations (legacy behavior)
            // so existing deployments don't suddenly lose daily/weekly availability.
            await dbAsync.exec(`
                UPDATE vps_products
                SET slot_daily   = CASE WHEN slot_daily   IS NULL OR slot_daily   = 0 THEN COALESCE(slot, 0) ELSE slot_daily   END,
                    slot_weekly  = CASE WHEN slot_weekly  IS NULL OR slot_weekly  = 0 THEN COALESCE(slot, 0) ELSE slot_weekly  END,
                    slot_monthly = CASE WHEN slot_monthly IS NULL OR slot_monthly = 0 THEN COALESCE(slot, 0) ELSE slot_monthly END
                WHERE slot > 0
            `);

            }

            // Keep legacy `slot` as the total for admin pages that still read it.
            await dbAsync.exec('UPDATE vps_products SET slot = COALESCE(slot_daily,0) + COALESCE(slot_weekly,0) + COALESCE(slot_monthly,0)');
        } catch (e) {
            console.warn('⚠️  Could not run vps_products stock-per-duration migration:', e?.message || e);
        }

        await dbAsync.exec(`
            CREATE TABLE IF NOT EXISTS vps_instances (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                api_id INTEGER NOT NULL,
                product_id INTEGER,
                droplet_id INTEGER,
                ip TEXT,
                region TEXT,
                image TEXT,
                root_password TEXT,
                created_at INTEGER,
                expires_at INTEGER NULL,
                duration_days INTEGER NULL,
                last_notified_at INTEGER NULL,
                deleted_at INTEGER NULL,
                status INTEGER DEFAULT 1,
                FOREIGN KEY (user_id) REFERENCES users(telegram_id),
                FOREIGN KEY (api_id) REFERENCES do_api(id),
                FOREIGN KEY (product_id) REFERENCES vps_products(id)
            )
        `);

// Migration for older databases: add expiry and bookkeeping columns if missing
        try {
            const cols = await dbAsync.all('PRAGMA table_info(vps_instances)');
            const hasExpires = Array.isArray(cols) && cols.some(c => c.name === 'expires_at');
            const hasDuration = Array.isArray(cols) && cols.some(c => c.name === 'duration_days');
            const hasNotified = Array.isArray(cols) && cols.some(c => c.name === 'last_notified_at');
            const hasDeletedAt = Array.isArray(cols) && cols.some(c => c.name === 'deleted_at');
            const hasOriginApi = Array.isArray(cols) && cols.some(c => c.name === 'origin_api_id');
            const hasRdpPort = Array.isArray(cols) && cols.some(c => c.name === 'rdp_port');
            if (!hasExpires) await dbAsync.exec('ALTER TABLE vps_instances ADD COLUMN expires_at INTEGER NULL');
            if (!hasDuration) await dbAsync.exec('ALTER TABLE vps_instances ADD COLUMN duration_days INTEGER NULL');
            if (!hasNotified) await dbAsync.exec('ALTER TABLE vps_instances ADD COLUMN last_notified_at INTEGER NULL');
            if (!hasDeletedAt) await dbAsync.exec('ALTER TABLE vps_instances ADD COLUMN deleted_at INTEGER NULL');
            if (!hasOriginApi) {
                await dbAsync.exec('ALTER TABLE vps_instances ADD COLUMN origin_api_id INTEGER NULL');
                await dbAsync.exec('UPDATE vps_instances SET origin_api_id = api_id WHERE origin_api_id IS NULL');
            }
            // rdp_port: port RDP per-instance (UpCloud=3389, lainnya=4443).
            // Instance lama tanpa kolom ini di-treat 4443 di display (fallback).
            if (!hasRdpPort) await dbAsync.exec('ALTER TABLE vps_instances ADD COLUMN rdp_port INTEGER NULL');
        } catch (e) {
            console.warn('⚠️  Could not run vps_instances migration:', e?.message || e);
        }


        // Create indexes for faster queries
        await dbAsync.exec(`
            CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
            CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
            CREATE INDEX IF NOT EXISTS idx_pending_payments_user_id ON pending_payments(user_id);
            CREATE INDEX IF NOT EXISTS idx_pending_payments_expiry ON pending_payments(expiry_time);
            CREATE INDEX IF NOT EXISTS idx_rdp_installations_user_id ON rdp_installations(user_id);
            CREATE INDEX IF NOT EXISTS idx_rdp_installations_status ON rdp_installations(status);

            CREATE INDEX IF NOT EXISTS idx_shop_stock_code_sold ON shop_stock_items(product_code, is_sold);
            CREATE INDEX IF NOT EXISTS idx_shop_stock_reserved ON shop_stock_items(product_code, is_sold, reserved_by_order_id, reserved_until);
            CREATE INDEX IF NOT EXISTS idx_shop_orders_user_status ON shop_orders(user_id, status);
            CREATE INDEX IF NOT EXISTS idx_shop_pending_user ON shop_pending_payments(user_id);
            CREATE INDEX IF NOT EXISTS idx_shop_pending_expiry ON shop_pending_payments(expiry_time);
        `);

        // Migration: Add transaction_id column if it doesn't exist
        await migrateDatabase();


        // Consolidate duplicate products (same api_id, product_type, size_slug, price) by summing slots.
        // This fixes cases where admin added the same spec multiple times and it appeared as duplicated menu entries.
        try {
            const dupGroups = await dbAsync.all(
                `SELECT api_id, product_type, size_slug, price, COUNT(*) as cnt
                 FROM vps_products
                 WHERE status = 1
                 GROUP BY api_id, product_type, size_slug, price
                 HAVING cnt > 1`
            );

            for (const g of dupGroups || []) {
                const rows = await dbAsync.all(
                    `SELECT id, slot, ram, core
                     FROM vps_products
                     WHERE status = 1 AND api_id = ? AND product_type = ? AND size_slug = ? AND price = ?
                     ORDER BY id ASC`,
                    [g.api_id, g.product_type, g.size_slug, g.price]
                );

                if (!rows || rows.length < 2) continue;

                const keepId = rows[0].id;
                const totalSlot = rows.reduce((s, r) => s + (Number(r.slot) || 0), 0);
                const ram = rows[0].ram;
                const core = rows[0].core;

                await dbAsync.run(
                    `UPDATE vps_products SET slot = ?, ram = ?, core = ? WHERE id = ?`,
                    [totalSlot, ram, core, keepId]
                );

                const deleteIds = rows.slice(1).map(r => r.id);
                const placeholders = deleteIds.map(() => '?').join(',');
                await dbAsync.run(
                    `DELETE FROM vps_products WHERE id IN (${placeholders})`,
                    deleteIds
                );
            }
        } catch (e) {
            console.warn('Duplicate product consolidation skipped:', e.message || e);
        }
        console.log('Database tables initialized successfully');
    } catch (error) {
        console.error('Error initializing database tables:', error);
        process.exit(1);
    }
}

// Database migration function
async function migrateDatabase() {
    try {
        // Check if transaction_id column exists in pending_payments
        const tableInfo = await dbAsync.all("PRAGMA table_info(pending_payments)");
        const hasTransactionId = tableInfo.some(column => column.name === 'transaction_id');
        
        if (!hasTransactionId) {
            console.log('Running migration: Adding transaction_id column to pending_payments...');
            await dbAsync.exec('ALTER TABLE pending_payments ADD COLUMN transaction_id TEXT');
            console.log('✅ Migration completed: transaction_id column added');
        }

        // Check if hostname column exists in rdp_installations
        const rdpTableInfo = await dbAsync.all("PRAGMA table_info(rdp_installations)");
        const hasHostname = rdpTableInfo.some(column => column.name === 'hostname');
        
        if (!hasHostname && rdpTableInfo.length > 0) {
            console.log('Running migration: Adding hostname column to rdp_installations...');
            await dbAsync.exec('ALTER TABLE rdp_installations ADD COLUMN hostname TEXT');
            console.log('✅ Migration completed: hostname column added');
        }

    } catch (error) {
        console.error('Migration error:', error);
        // Don't exit on migration errors, continue with app startup
    }
}

// Database maintenance functions
const maintenance = {
    // Clean up expired payments
    async cleanupExpiredPayments() {
        try {
            const result = await dbAsync.run(
                'DELETE FROM pending_payments WHERE expiry_time <= ?',
                [Date.now()]
            );
            if (result.changes > 0) {
                console.log(`🧹 Cleaned up ${result.changes} expired payments`);
            }
            return result.changes;
        } catch (error) {
            console.error('Error cleaning up expired payments:', error);
            return 0;
        }
    },

    // Clean up old transactions (older than 1 year)
    async cleanupOldTransactions() {
        try {
            const oneYearAgo = new Date();
            oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
            
            const result = await dbAsync.run(
                'DELETE FROM transactions WHERE created_at < ?',
                [oneYearAgo.toISOString()]
            );
            if (result.changes > 0) {
                console.log(`🧹 Cleaned up ${result.changes} old transactions`);
            }
            return result.changes;
        } catch (error) {
            console.error('Error cleaning up old transactions:', error);
            return 0;
        }
    },

    // Get database statistics
    async getStats() {
        try {
            const users = await dbAsync.get('SELECT COUNT(*) as count FROM users');
            const transactions = await dbAsync.get('SELECT COUNT(*) as count FROM transactions');
            const pendingPayments = await dbAsync.get('SELECT COUNT(*) as count FROM pending_payments');
            const rdpInstallations = await dbAsync.get('SELECT COUNT(*) as count FROM rdp_installations WHERE status = "completed"');

            return {
                users: users.count,
                transactions: transactions.count,
                pendingPayments: pendingPayments.count,
                completedRDPs: rdpInstallations.count
            };
        } catch (error) {
            console.error('Error getting database stats:', error);
            return null;
        }
    }
};

// Schedule automatic maintenance
setInterval(async () => {
    await maintenance.cleanupExpiredPayments();
}, 30 * 60 * 1000); // Every 30 minutes

// Weekly cleanup of old transactions
setInterval(async () => {
    await maintenance.cleanupOldTransactions();
}, 7 * 24 * 60 * 60 * 1000); // Every 7 days

// Initialize database on startup
initDatabase();

// Close database on process termination
process.on('SIGINT', () => {
    console.log('🔄 Shutting down bot gracefully...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('Database connection closed');
        }
        process.exit(err ? 1 : 0);
    });
});

// Export database instance and maintenance functions
module.exports = {
    ...dbAsync,
    maintenance,
    raw: db // Raw database instance for advanced operations
};