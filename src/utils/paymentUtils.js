function isPaymentStatusSuccessful(payment) {
    if (!payment) return false;
    
    const status = payment.status || payment.data?.status;
    
    const successStatuses = ['success', 'processing', 'pending', 'created', 'active'];
    
    if (typeof status === 'string') {
        return successStatuses.includes(status.toLowerCase());
    }
    
    return false;
}

function getPaymentStatus(payment) {
    if (!payment) return null;
    
    return payment.status || payment.data?.status;
}

function isPaymentCompleted(payment) {
    if (!payment) return false;
    
    const status = payment.status || payment.data?.status;
    const completedStatuses = ['success', 'settlement', 'capture', 'paid'];
    
    if (typeof status === 'string') {
        return completedStatuses.includes(status.toLowerCase());
    }
    
    return false;
}

function isPaymentFailed(payment) {
    if (!payment) return false;
    
    const status = payment.status || payment.data?.status;
    const failedStatuses = ['failed', 'cancelled', 'expired', 'deny'];
    
    if (typeof status === 'string') {
        return failedStatuses.includes(status.toLowerCase());
    }
    
    return false;
}

function isPaymentPending(payment) {
    if (!payment) return false;
    
    const status = payment.status || payment.data?.status;
    const pendingStatuses = ['processing', 'pending', 'created'];
    
    if (typeof status === 'string') {
        return pendingStatuses.includes(status.toLowerCase());
    }
    
    return false;
}

function validatePaymentAmount(amount) {
    if (!amount || isNaN(amount)) {
        return { valid: false, error: 'Amount must be a valid number' };
    }
    
    if (amount < 5000) {
        return { valid: false, error: 'Minimum amount is Rp 5,000' };
    }
    
    if (amount > 10000000) {
        return { valid: false, error: 'Maximum amount is Rp 10,000,000' };
    }
    
    return { valid: true };
}

function formatPaymentAmount(amount) {
    if (!amount || isNaN(amount)) return 'Rp 0';
    
    return `Rp ${amount.toLocaleString('id-ID')}`;
}

function generateUniquePaymentCode(prefix = 'DEP', userId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${prefix}${timestamp}${userId}${random}`;
}

function calculatePaymentExpiry(minutes = 30) {
    return new Date(Date.now() + (minutes * 60 * 1000)).getTime();
}

function isPaymentExpired(expiryTime) {
    return Date.now() > expiryTime;
}

function formatExpiryTime(expiryTime) {
    const expiredAt = new Date(expiryTime);
    return expiredAt.toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

module.exports = {
    isPaymentStatusSuccessful,
    getPaymentStatus,
    isPaymentCompleted,
    isPaymentFailed,
    isPaymentPending,
    validatePaymentAmount,
    formatPaymentAmount,
    generateUniquePaymentCode,
    calculatePaymentExpiry,
    isPaymentExpired,
    formatExpiryTime
};