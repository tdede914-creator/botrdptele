class SessionManager {
    constructor() {
        this.userSessions = new Map();
        this.adminSessions = new Map();
        this.depositSessions = new Map();
        this.shopSessions = new Map();
        this.accountSessions = new Map();
        this.sessionTimeouts = new Map();
        
        // Session timeout in milliseconds (30 minutes)
        this.SESSION_TIMEOUT = 30 * 60 * 1000;
        
        // Cleanup expired sessions every 5 minutes
        setInterval(() => {
            this.cleanupExpiredSessions();
        }, 5 * 60 * 1000);
    }

    setUserSession(chatId, session) {
        this.userSessions.set(chatId, {
            ...session,
            lastActivity: Date.now()
        });
        
        // Clear existing timeout
        if (this.sessionTimeouts.has(chatId)) {
            clearTimeout(this.sessionTimeouts.get(chatId));
        }
        
        // Set new timeout
        const timeout = setTimeout(() => {
            this.clearUserSession(chatId);
        }, this.SESSION_TIMEOUT);
        
        this.sessionTimeouts.set(chatId, timeout);
    }

    getUserSession(chatId) {
        const session = this.userSessions.get(chatId);
        if (session) {
            // Update last activity
            session.lastActivity = Date.now();
            return session;
        }
        return null;
    }

    clearUserSession(chatId) {
        this.userSessions.delete(chatId);
        if (this.sessionTimeouts.has(chatId)) {
            clearTimeout(this.sessionTimeouts.get(chatId));
            this.sessionTimeouts.delete(chatId);
        }
    }

    setAdminSession(chatId, session) {
        this.adminSessions.set(chatId, {
            ...session,
            lastActivity: Date.now()
        });
    }

    getAdminSession(chatId) {
        const session = this.adminSessions.get(chatId);
        if (session) {
            session.lastActivity = Date.now();
            return session;
        }
        return null;
    }

    clearAdminSession(chatId) {
        this.adminSessions.delete(chatId);
    }

    setDepositSession(chatId, session) {
        this.depositSessions.set(chatId, {
            ...session,
            lastActivity: Date.now()
        });
    }

    getDepositSession(chatId) {
        const session = this.depositSessions.get(chatId);
        if (session) {
            session.lastActivity = Date.now();
            return session;
        }
        return null;
    }

    clearDepositSession(chatId) {
        this.depositSessions.delete(chatId);
    }

    setShopSession(chatId, session) {
        this.shopSessions.set(chatId, {
            ...session,
            lastActivity: Date.now()
        });
    }

    getShopSession(chatId) {
        const session = this.shopSessions.get(chatId);
        if (session) {
            session.lastActivity = Date.now();
            return session;
        }
        return null;
    }

    clearShopSession(chatId) {
        this.shopSessions.delete(chatId);
    }

    setAccountSession(chatId, session) {
        this.accountSessions.set(chatId, {
            ...session,
            lastActivity: Date.now()
        });
    }

    getAccountSession(chatId) {
        const session = this.accountSessions.get(chatId);
        if (session) {
            session.lastActivity = Date.now();
            return session;
        }
        return null;
    }

    clearAccountSession(chatId) {
        this.accountSessions.delete(chatId);
    }

    clearAllSessions(chatId) {
        this.clearUserSession(chatId);
        this.clearAdminSession(chatId);
        this.clearDepositSession(chatId);
        this.clearShopSession(chatId);
        this.clearAccountSession(chatId);
    }

    cleanupExpiredSessions() {
        const now = Date.now();
        const expiredChatIds = [];

        // Check user sessions
        for (const [chatId, session] of this.userSessions.entries()) {
            if (now - session.lastActivity > this.SESSION_TIMEOUT) {
                expiredChatIds.push(chatId);
            }
        }

        // Check admin sessions
        for (const [chatId, session] of this.adminSessions.entries()) {
            if (now - session.lastActivity > this.SESSION_TIMEOUT) {
                expiredChatIds.push(chatId);
            }
        }

        // Check deposit sessions
        for (const [chatId, session] of this.depositSessions.entries()) {
            if (now - session.lastActivity > this.SESSION_TIMEOUT) {
                expiredChatIds.push(chatId);
            }
        }

        // Check shop sessions
        for (const [chatId, session] of this.shopSessions.entries()) {
            if (now - session.lastActivity > this.SESSION_TIMEOUT) {
                expiredChatIds.push(chatId);
            }
        }

        // Check account sessions
        for (const [chatId, session] of this.accountSessions.entries()) {
            if (now - session.lastActivity > this.SESSION_TIMEOUT) {
                expiredChatIds.push(chatId);
            }
        }

        // Clear expired sessions
        expiredChatIds.forEach(chatId => {
            this.clearAllSessions(chatId);
        });

        if (expiredChatIds.length > 0) {
            console.log(`🧹 Cleaned up ${expiredChatIds.length} expired sessions`);
        }
    }

    getSessionStats() {
        return {
            userSessions: this.userSessions.size,
            adminSessions: this.adminSessions.size,
            depositSessions: this.depositSessions.size,
            shopSessions: this.shopSessions.size,
            accountSessions: this.accountSessions.size,
            totalTimeouts: this.sessionTimeouts.size
        };
    }

    // Method to check if session is valid
    isSessionValid(chatId, sessionType = 'user') {
        let session;
        switch (sessionType) {
            case 'user':
                session = this.getUserSession(chatId);
                break;
            case 'admin':
                session = this.getAdminSession(chatId);
                break;
            case 'deposit':
                session = this.getDepositSession(chatId);
                break;
            case 'shop':
                session = this.getShopSession(chatId);
                break;
            case 'account':
                session = this.getAccountSession(chatId);
                break;
            default:
                return false;
        }
        
        if (!session) return false;
        
        // Check if session is expired
        const now = Date.now();
        return (now - session.lastActivity) < this.SESSION_TIMEOUT;
    }
}

module.exports = SessionManager;