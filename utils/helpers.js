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

/**
 * Safely create an AuditLog record.
 * If creation fails, logs the error but does NOT throw — never crashes the caller.
 */
async function safeAuditLog({ action, performedBy, targetType = '', targetId = null, details = {}, ipAddress = '' }) {
    try {
        const AuditLog = require('../models/AuditLog');
        await AuditLog.create({ action, performedBy, targetType, targetId, details, ipAddress });
    } catch (err) {
        const logger = require('./logger');
        logger.error('AUDIT', `Failed to write AuditLog (action=${action}): ${err.message}`);
    }
}

/**
 * Emit an event to a specific user's scoped room on the /v2 namespace.
 * Only the authenticated socket(s) in that user's room will receive it.
 */
function emitToUser(io, userId, event, payload) {
    try {
        io.of('/v2').to(`user:${String(userId)}`).emit(event, payload);
    } catch (err) {
        const logger = require('./logger');
        logger.error('EMIT', `emitToUser failed (${event} → user:${userId}): ${err.message}`);
    }
}

/**
 * Emit an event to the admin:notifications room on the /v2 namespace.
 * Only authenticated admin sockets receive it.
 */
function emitToAdmin(io, event, payload) {
    try {
        io.of('/v2').to('admin:notifications').emit(event, payload);
    } catch (err) {
        const logger = require('./logger');
        logger.error('EMIT', `emitToAdmin failed (${event}): ${err.message}`);
    }
}

/**
 * Emit an event to a specific match room on the /v2 namespace.
 * Only sockets that joined match:<matchId> receive it.
 */
function emitToMatch(io, matchId, event, payload) {
    try {
        io.of('/v2').to(`match:${String(matchId)}`).emit(event, payload);
    } catch (err) {
        const logger = require('./logger');
        logger.error('EMIT', `emitToMatch failed (${event} → match:${matchId}): ${err.message}`);
    }
}

module.exports = { compareVersions, sanitizeUser, paginationMeta, asyncHandler, generateReferralCode, safeAuditLog, emitToUser, emitToAdmin, emitToMatch };
