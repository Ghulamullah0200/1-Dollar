/**
 * Game Routes — All game API endpoints
 * Mounts under /api/games
 */
const express = require('express');
const router = express.Router();
const { auth, adminAuth } = require('../../middleware/auth');
const {
    validateGameName,
    requireSubscription,
    requireVerified,
    requireGameActive,
    validateScore,
    gameRateLimit
} = require('../middleware/gameMiddleware');

// ═══ Models ═══
const GameSettings = require('../models/GameSettings');
const GameSubscription = require('../models/GameSubscription');
const GameMatch = require('../models/GameMatch');
const PlayerStats = require('../models/PlayerStats');
const Transaction = require('../../models/Transaction');
const User = require('../../models/User');

// ═══ Services ═══
const QueueManager = require('../services/queueManager');
const MatchManager = require('../services/matchManager');
const RewardEngine = require('../services/rewardEngine');
const AnalyticsEngine = require('../services/analyticsEngine');
const GameNotificationService = require('../services/gameNotificationService');

// ══════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ══════════════════════════════════════════════════════════

/**
 * GET /api/games/settings — Get all game settings (public)
 */
router.get('/settings', async (req, res) => {
    try {
        const settings = await GameSettings.getAllSettings();
        res.json(settings);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * GET /api/games/settings/:gameName — Get specific game settings
 */
router.get('/settings/:gameName', validateGameName, async (req, res) => {
    try {
        const settings = await GameSettings.getForGame(req.gameName);
        res.json(settings);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * GET /api/games/leaderboard/:gameName — Public leaderboard
 */
router.get('/leaderboard/:gameName', validateGameName, async (req, res) => {
    try {
        const sortBy = req.query.sortBy || 'highScore';
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const leaderboard = await PlayerStats.getLeaderboard(req.gameName, sortBy, limit);
        res.json(leaderboard);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * GET /api/games/queue-status/:gameName — Public queue status
 */
router.get('/queue-status/:gameName', validateGameName, async (req, res) => {
    try {
        const status = await QueueManager.getQueueStatus(req.gameName);
        res.json(status);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ══════════════════════════════════════════════════════════
// AUTHENTICATED PLAYER ROUTES
// ══════════════════════════════════════════════════════════

/**
 * GET /api/games/subscription/status/:gameName — Check subscription
 */
router.get('/subscription/status/:gameName', auth, validateGameName, async (req, res) => {
    try {
        const sub = await GameSubscription.getActive(req.userId, req.gameName);
        res.json({
            hasSubscription: !!sub,
            subscription: sub ? {
                expiresAt: sub.expiresAt,
                daysRemaining: Math.max(0, Math.ceil((sub.expiresAt - Date.now()) / (1000 * 60 * 60 * 24))),
                purchasedAt: sub.purchasedAt
            } : null
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * POST /api/games/subscription/purchase — Purchase subscription
 */
router.post('/subscription/purchase', auth, requireVerified, gameRateLimit, async (req, res) => {
    try {
        const { gameName } = req.body;
        if (!gameName || !['flappy-bird', 'fruit-ninja'].includes(gameName)) {
            return res.status(400).json({ message: 'Invalid game name' });
        }

        // Check if already subscribed
        const existing = await GameSubscription.getActive(req.userId, gameName);
        if (existing) {
            return res.status(400).json({
                message: 'You already have an active subscription',
                expiresAt: existing.expiresAt
            });
        }

        // Get settings
        const settings = await GameSettings.getForGame(gameName);
        if (!settings.isActive) {
            return res.status(400).json({ message: 'This game is currently disabled' });
        }

        // Check wallet balance
        const user = await User.findById(req.userId);
        if (user.wallet.balance < settings.subscriptionPrice) {
            return res.status(400).json({
                message: `Insufficient balance. Subscription costs $${settings.subscriptionPrice.toFixed(2)}`
            });
        }

        // Deduct from wallet
        user.wallet.balance -= settings.subscriptionPrice;
        await user.save();

        // Create transaction
        const transaction = await Transaction.create({
            userId: req.userId,
            type: 'game_subscription',
            amount: -settings.subscriptionPrice,
            status: 'completed',
            description: `${settings.displayName} subscription — ${settings.subscriptionDurationDays} days`,
            processedAt: new Date()
        });

        // Create subscription
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + settings.subscriptionDurationDays);

        const subscription = await GameSubscription.create({
            userId: req.userId,
            gameName,
            amount: settings.subscriptionPrice,
            expiresAt,
            transactionId: transaction._id
        });

        res.json({
            message: 'Subscription activated!',
            subscription: {
                gameName,
                expiresAt,
                daysRemaining: settings.subscriptionDurationDays,
                amount: settings.subscriptionPrice
            },
            wallet: { balance: user.wallet.balance }
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * POST /api/games/queue/join — Join game queue
 */
router.post('/queue/join', auth, requireVerified, gameRateLimit, async (req, res) => {
    try {
        const { gameName, deviceInfo } = req.body;
        if (!gameName || !['flappy-bird', 'fruit-ninja'].includes(gameName)) {
            return res.status(400).json({ message: 'Invalid game name' });
        }

        const result = await QueueManager.joinQueue(req.userId, gameName, deviceInfo || {});

        // Emit socket events
        if (req.io) {
            req.io.emit('queue:update', { gameName, count: result.queuePosition });

            // If matches were created, notify players
            if (result.matchCreated && result.match) {
                for (const match of result.match) {
                    const playerIds = match.players.map(p => p.userId);
                    await GameNotificationService.notifyMatchFound(playerIds, gameName, match._id);

                    playerIds.forEach(pid => {
                        req.io.emit(`match:found:${pid}`, {
                            matchId: match._id,
                            gameName,
                            players: match.players
                        });
                    });
                }
            }
        }

        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/**
 * POST /api/games/queue/leave — Leave game queue
 */
router.post('/queue/leave', auth, async (req, res) => {
    try {
        const { gameName } = req.body;
        const entry = await QueueManager.leaveQueue(req.userId, gameName);

        if (req.io) {
            const status = await QueueManager.getQueueStatus(gameName);
            req.io.emit('queue:update', { gameName, count: status.queueCount });
        }

        res.json({ message: 'Left the queue', entry });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/**
 * GET /api/games/queue/my-position/:gameName — Get user's queue position
 */
router.get('/queue/my-position/:gameName', auth, validateGameName, async (req, res) => {
    try {
        const position = await QueueManager.getUserQueuePosition(req.userId, req.gameName);
        res.json({ position, inQueue: position !== null });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * POST /api/games/match/submit-score — Submit game score
 */
router.post('/match/submit-score', auth, validateScore, gameRateLimit, async (req, res) => {
    try {
        const { matchId, score, duration, scoreHash, deviceInfo } = req.body;
        if (!matchId) return res.status(400).json({ message: 'matchId is required' });

        const result = await MatchManager.submitScore(
            req.userId, matchId, score, duration, scoreHash, deviceInfo
        );

        // Emit socket events
        if (req.io) {
            if (result.status === 'completed' && result.winner) {
                // Notify winner
                await GameNotificationService.notifyWinner(
                    result.winner.userId,
                    result.match.gameName,
                    result.winner.prize
                );
                await GameNotificationService.notifyRewardCredited(
                    result.winner.userId,
                    result.winner.prize
                );

                // Notify all players
                const playerIds = result.match.players.map(p => p.userId);
                await GameNotificationService.notifyMatchResult(
                    playerIds,
                    result.match.gameName,
                    result.winner.username,
                    result.winner.userId
                );

                // Socket events
                playerIds.forEach(pid => {
                    req.io.emit(`match:result:${pid}`, {
                        matchId,
                        winner: result.winner,
                        match: result.match
                    });
                });
            }
        }

        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/**
 * GET /api/games/match/active — Get user's active match
 */
router.get('/match/active', auth, async (req, res) => {
    try {
        const match = await MatchManager.getActiveMatch(req.userId);
        res.json({ hasActiveMatch: !!match, match });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * GET /api/games/match/history — Match history
 */
router.get('/match/history', auth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const skip = parseInt(req.query.skip) || 0;
        const history = await MatchManager.getMatchHistory(req.userId, limit, skip);
        res.json(history);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * GET /api/games/match/:matchId — Get match details
 */
router.get('/match/:matchId', auth, async (req, res) => {
    try {
        const status = await MatchManager.getMatchStatus(req.params.matchId);
        res.json(status);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/**
 * GET /api/games/stats/:gameName — Player stats
 */
router.get('/stats/:gameName', auth, validateGameName, async (req, res) => {
    try {
        const stats = await PlayerStats.getOrCreate(req.userId, req.user.username, req.gameName);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * GET /api/games/earnings — Earnings history
 */
router.get('/earnings', auth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const earnings = await RewardEngine.getEarningsHistory(req.userId, limit);
        res.json(earnings);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ══════════════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════════════

/**
 * GET /api/games/admin/dashboard — Admin dashboard stats
 */
router.get('/admin/dashboard', adminAuth, async (req, res) => {
    try {
        const stats = await AnalyticsEngine.getDashboardStats();
        const activePlayers = await AnalyticsEngine.getActivePlayerCount();
        res.json({ ...stats, activePlayers });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * PUT /api/games/admin/settings/:gameName — Update game settings
 */
router.put('/admin/settings/:gameName', adminAuth, validateGameName, async (req, res) => {
    try {
        const settings = await GameSettings.updateForGame(req.gameName, req.body, req.userId);

        if (req.io) {
            req.io.emit('game:settings:updated', { gameName: req.gameName, settings });
        }

        res.json({ message: 'Settings updated', settings });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * GET /api/games/admin/matches — All matches with filters
 */
router.get('/admin/matches', adminAuth, async (req, res) => {
    try {
        const { gameName, status, page, limit } = req.query;
        const result = await AnalyticsEngine.getMatchesForAdmin({
            gameName, status,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 20
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * POST /api/games/admin/cancel-match/:matchId — Cancel a match
 */
router.post('/admin/cancel-match/:matchId', adminAuth, async (req, res) => {
    try {
        const match = await MatchManager.cancelMatch(req.params.matchId);
        res.json({ message: 'Match cancelled and players refunded', match });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/**
 * POST /api/games/admin/process-queue/:gameName — Force process queue
 */
router.post('/admin/process-queue/:gameName', adminAuth, validateGameName, async (req, res) => {
    try {
        const result = await QueueManager.processQueue(req.gameName);
        res.json({
            message: result ? `Created ${result.length} match(es)` : 'Not enough players in queue',
            matches: result
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * GET /api/games/admin/analytics — Revenue analytics
 */
router.get('/admin/analytics', adminAuth, async (req, res) => {
    try {
        const [revenue, dailyMatches, topPlayersFlappy, topPlayersNinja] = await Promise.all([
            RewardEngine.getTotalRevenue(),
            AnalyticsEngine.getDailyMatchCounts(30),
            AnalyticsEngine.getTopPlayers('flappy-bird', 10),
            AnalyticsEngine.getTopPlayers('fruit-ninja', 10)
        ]);
        res.json({ revenue, dailyMatches, topPlayers: { 'flappy-bird': topPlayersFlappy, 'fruit-ninja': topPlayersNinja } });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/**
 * POST /api/games/admin/finalize-timeouts — Force finalize timed-out matches
 */
router.post('/admin/finalize-timeouts', adminAuth, async (req, res) => {
    try {
        const results = await MatchManager.finalizeTimedOutMatches();
        res.json({ message: `Finalized ${results.length} match(es)`, results });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
