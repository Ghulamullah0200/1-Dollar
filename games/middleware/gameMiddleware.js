/**
 * Game Middleware — Validation middleware for game routes
 */
const GameSettings = require('../models/GameSettings');
const GameSubscription = require('../models/GameSubscription');
const User = require('../../models/User');
const crypto = require('crypto');

/**
 * Validate game name parameter
 */
const validateGameName = (req, res, next) => {
    const gameName = req.params.gameName || req.body.gameName;
    if (!gameName || !['flappy-bird', 'fruit-ninja'].includes(gameName)) {
        return res.status(400).json({ message: 'Invalid game name. Must be "flappy-bird" or "fruit-ninja".' });
    }
    req.gameName = gameName;
    next();
};

/**
 * Require active subscription for the game
 */
const requireSubscription = async (req, res, next) => {
    try {
        const gameName = req.gameName || req.params.gameName || req.body.gameName;
        const hasSub = await GameSubscription.hasActive(req.userId, gameName);
        if (!hasSub) {
            return res.status(403).json({
                message: 'Active subscription required',
                code: 'SUBSCRIPTION_REQUIRED'
            });
        }
        next();
    } catch (err) {
        res.status(500).json({ message: 'Subscription check failed' });
    }
};

/**
 * Require verified deposit status
 */
const requireVerified = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId).select('depositStatus').lean();
        if (!user || user.depositStatus !== 'verified') {
            return res.status(403).json({
                message: 'Account must be verified to play games',
                code: 'VERIFICATION_REQUIRED'
            });
        }
        next();
    } catch (err) {
        res.status(500).json({ message: 'Verification check failed' });
    }
};

/**
 * Validate game is active
 */
const requireGameActive = async (req, res, next) => {
    try {
        const gameName = req.gameName || req.params.gameName || req.body.gameName;
        const settings = await GameSettings.getForGame(gameName);
        if (!settings.isActive) {
            return res.status(403).json({
                message: 'This game is currently disabled',
                code: 'GAME_DISABLED'
            });
        }
        req.gameSettings = settings;
        next();
    } catch (err) {
        res.status(500).json({ message: 'Game status check failed' });
    }
};

/**
 * Anti-cheat score validation middleware
 */
const validateScore = (req, res, next) => {
    const { score, duration, scoreHash } = req.body;

    // Basic validation
    if (typeof score !== 'number' || score < 0) {
        return res.status(400).json({ message: 'Invalid score' });
    }
    if (typeof duration !== 'number' || duration < 0) {
        return res.status(400).json({ message: 'Invalid duration' });
    }

    // Score hash verification (simple HMAC)
    if (scoreHash) {
        const secret = process.env.GAME_SCORE_SECRET || process.env.JWT_SECRET;
        const expectedHash = crypto
            .createHmac('sha256', secret)
            .update(`${req.userId}:${req.body.matchId}:${score}:${duration}`)
            .digest('hex');

        if (scoreHash !== expectedHash) {
            return res.status(403).json({
                message: 'Score verification failed',
                code: 'INVALID_SCORE_HASH'
            });
        }
    }

    next();
};

/**
 * Rate limiting for game actions (per user)
 */
const gameRateLimit = (() => {
    const attempts = new Map();
    const WINDOW_MS = 5000; // 5 seconds
    const MAX_ATTEMPTS = 3;

    return (req, res, next) => {
        const key = `${req.userId}:game`;
        const now = Date.now();
        const userAttempts = attempts.get(key) || [];

        // Clean old attempts
        const recent = userAttempts.filter(t => now - t < WINDOW_MS);

        if (recent.length >= MAX_ATTEMPTS) {
            return res.status(429).json({ message: 'Too many requests. Slow down.' });
        }

        recent.push(now);
        attempts.set(key, recent);

        // Cleanup old keys periodically
        if (attempts.size > 10000) {
            for (const [k, v] of attempts) {
                if (v.every(t => now - t > WINDOW_MS)) attempts.delete(k);
            }
        }

        next();
    };
})();

module.exports = {
    validateGameName,
    requireSubscription,
    requireVerified,
    requireGameActive,
    validateScore,
    gameRateLimit
};
