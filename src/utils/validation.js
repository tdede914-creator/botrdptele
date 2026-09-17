class ValidationUtils {
    static validateIP(ip) {
        const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (!ipRegex.test(ip)) {
            return { valid: false, message: 'Format IP tidak valid. Gunakan format: xxx.xxx.xxx.xxx' };
        }
        
        const parts = ip.split('.');
        for (const part of parts) {
            const num = parseInt(part);
            if (num < 0 || num > 255) {
                return { valid: false, message: 'Setiap bagian IP harus antara 0-255' };
            }
        }
        
        return { valid: true };
    }

    static validatePassword(password) {
        if (password.length < 8) {
            return { valid: false, message: 'Password harus minimal 8 karakter' };
        }
        
        if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d@#$%^&+=]{8,}$/.test(password)) {
            return { valid: false, message: 'Password harus mengandung huruf dan angka' };
        }
        
        return { valid: true };
    }

    static validateAmount(amount) {
        const num = parseFloat(amount);
        if (isNaN(num)) {
            return { valid: false, message: 'Jumlah harus berupa angka' };
        }
        
        if (num <= 0) {
            return { valid: false, message: 'Jumlah harus lebih dari 0' };
        }
        
        if (num < 10000) {
            return { valid: false, message: 'Minimum deposit adalah Rp 10.000' };
        }
        
        return { valid: true, amount: num };
    }

    static validateUserID(userId) {
        if (!userId || typeof userId !== 'string') {
            return { valid: false, message: 'User ID tidak valid' };
        }
        
        if (!/^\d+$/.test(userId)) {
            return { valid: false, message: 'User ID harus berupa angka' };
        }
        
        return { valid: true };
    }

    static sanitizeInput(input) {
        if (typeof input !== 'string') return '';
        
        // Remove potentially dangerous characters
        return input
            .replace(/[<>\"'&]/g, '')
            .trim()
            .substring(0, 1000); // Limit length
    }

    static validateSession(session, requiredFields = []) {
        if (!session) {
            return { valid: false, message: 'Sesi tidak ditemukan' };
        }
        
        for (const field of requiredFields) {
            if (!session[field]) {
                return { valid: false, message: `Field ${field} tidak ditemukan dalam sesi` };
            }
        }
        
        return { valid: true };
    }

    static validateVPSCredentials(ip, password) {
        const ipValidation = this.validateIP(ip);
        if (!ipValidation.valid) {
            return ipValidation;
        }
        
        if (!password || password.length < 3) {
            return { valid: false, message: 'Password VPS tidak valid' };
        }
        
        return { valid: true };
    }

    static validateRDPPassword(password) {
        return this.validatePassword(password);
    }

    static validateWindowsVersion(versionId, availableVersions) {
        const version = availableVersions.find(v => v.id === versionId);
        if (!version) {
            return { valid: false, message: 'Versi Windows tidak valid' };
        }
        
        return { valid: true, version };
    }

    static validateOSVersion(osVersion, availableVersions) {
        const version = availableVersions.find(v => v.version === osVersion);
        if (!version) {
            return { valid: false, message: 'Versi OS tidak valid' };
        }
        
        return { valid: true, version };
    }

    static createErrorMessage(message, suggestions = []) {
        let errorMsg = `❌ ${message}`;
        
        if (suggestions.length > 0) {
            errorMsg += '\n\n💡 Saran:\n';
            suggestions.forEach(suggestion => {
                errorMsg += `• ${suggestion}\n`;
            });
        }
        
        return errorMsg;
    }

    static createSuccessMessage(message, details = []) {
        let successMsg = `✅ ${message}`;
        
        if (details.length > 0) {
            successMsg += '\n\n📋 Detail:\n';
            details.forEach(detail => {
                successMsg += `• ${detail}\n`;
            });
        }
        
        return successMsg;
    }
}

module.exports = ValidationUtils;