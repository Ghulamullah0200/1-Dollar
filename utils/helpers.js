/**
 * Compare two semver version strings
 * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
    const parts1 = String(v1).split('.').map(Number);
    const parts2 = String(v2).split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const a = parts1[i] || 0;
        const b = parts2[i] || 0;
        if (a > b) return 1;
        if (a < b) return -1;
    }
    return 0;
}

/**
 * Sanitize user object for API response (strip sensitive fields)
 */
function sanitizeUser(user) {
    const obj = user.toObject ? user.toObject() : { ...user };
    delete obj.password;
    delete obj.__v;
    return obj;
}

/**
 * Build pagination metadata
 */
function paginationMeta(page, limit, total) {
    return {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
    };
}

/**
 * Async route handler wrapper — catches errors and passes to middleware
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Generate a unique referral code from userId
 */
function generateReferralCode(userId) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(userId.toString()).digest('hex').substring(0, 8).toUpperCase();
}

module.exports = { compareVersions, sanitizeUser, paginationMeta, asyncHandler, generateReferralCode };
