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
const { emitToUser } = require('../../utils/helpers');
const { SUPPORTED_GAMES } = require('../constants');
const RoomManager = require('../services/roomManager');

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
        if (!gameName || !SUPPORTED_GAMES.includes(gameName)) {
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

        // Idempotency key — use client-provided key or generate a server-side fallback
        const clientKey = req.body.idempotencyKey;
        const idempotencyKey = clientKey
            ? `sub_${req.userId}_${gameName}_${clientKey}`
            : `sub_${req.userId}_${gameName}_${Date.now().toString(36)}`;

        // Guard against duplicate purchase via idempotencyKey
        const existingTxn = clientKey
            ? await Transaction.findOne({ idempotencyKey: `sub_${req.userId}_${gameName}_${clientKey}` })
            : null;
        if (existingTxn) {
            return res.status(400).json({ message: 'Duplicate request — subscription already processed.' });
        }

        // Atomic wallet deduction with $gte guard — prevents race condition
        const user = await User.findOneAndUpdate(
            { _id: req.userId, 'wallet.balance': { $gte: settings.subscriptionPrice } },
            { $inc: { 'wallet.balance': -settings.subscriptionPrice } },
            { new: true }
        );
        if (!user) {
            return res.status(400).json({
                message: `Insufficient balance. Subscription costs $${settings.subscriptionPrice.toFixed(2)}`
            });
        }

        // Create transaction
        const transaction = await Transaction.create({
            userId: req.userId,
            type: 'game_subscription',
            amount: -settings.subscriptionPrice,
            status: 'completed',
            description: `${settings.displayName} subscription — ${settings.subscriptionDurationDays} days`,
            processedAt: new Date(),
            idempotencyKey
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
        if (!gameName || !SUPPORTED_GAMES.includes(gameName)) {
            return res.status(400).json({ message: 'Invalid game name' });
        }

        // Reject inactive / coming-soon games before entering queue
        const joinGameSettings = await GameSettings.getForGame(gameName);
        if (!joinGameSettings.isActive) {
            return res.status(400).json({
                message: `${joinGameSettings.displayName} is not available yet. Coming soon!`,
                code: 'GAME_INACTIVE'
            });
        }

        const result = await QueueManager.joinQueue(req.userId, gameName, deviceInfo || {});

        // Emit socket events
        if (req.io) {
            req.io.emit('queue:update', { gameName, count: result.queuePosition });
            req.io.of('/v2').emit('queue:update', { gameName, count: result.queuePosition });

            // If matches were created, notify players
            if (result.matchCreated && result.match) {
                for (const match of result.match) {
                    const playerIds = match.players.map(p => p.userId);
                    await GameNotificationService.notifyMatchFound(playerIds, gameName, match._id);

                    const matchPayload = { matchId: match._id, gameName, players: match.players };
                    playerIds.forEach(pid => {
                        req.io.emit(`match:found:${pid}`, matchPayload); // legacy
                        emitToUser(req.io, pid, 'match:found', matchPayload); // /v2 scoped
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
            req.io.of('/v2').emit('queue:update', { gameName, count: status.queueCount });
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
                const resultPayload = { matchId, winner: result.winner, match: result.match };
                playerIds.forEach(pid => {
                    req.io.emit(`match:result:${pid}`, resultPayload); // legacy
                    emitToUser(req.io, pid, 'match:result', resultPayload); // /v2 scoped
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

/**
 * POST /api/games/admin/finalize-turn-timeouts
 * Manually trigger human-turn-timeout finalization for active Carrom bot rooms.
 * Paid rooms where the human's turn exceeded turnTimeoutSeconds are forfeited to the bot.
 * Free-practice rooms are cancelled.
 */
router.post('/admin/finalize-turn-timeouts', adminAuth, async (req, res) => {
    try {
        const count = await RoomManager.finalizeTurnTimeouts(req.ioV2);
        res.json({
            success: true,
            message: `Finalised ${count} timed-out turn(s).`,
            data: { turnTimeouts: count }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/games/admin/finalize-room-timeouts
 * Manually trigger waiting-room and disconnect-timeout finalization for Carrom / Ludo rooms.
 * Useful for testing and for catching up after a server restart.
 */
router.post('/admin/finalize-room-timeouts', adminAuth, async (req, res) => {
    try {
        const [waitingCount, disconnectedCount] = await Promise.all([
            RoomManager.finalizeTimedOutRooms(req.io),
            RoomManager.finalizeDisconnectedRooms(req.io)
        ]);
        res.json({
            success: true,
            message:
                `Cancelled ${waitingCount} waiting room(s) and ` +
                `${disconnectedCount} disconnected room(s).`,
            data: { waitingTimeouts: waitingCount, disconnectTimeouts: disconnectedCount }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══════════════════════════════════════════════════════════
// ADMIN ROOM MONITORING  (Phase 4A)
// ══════════════════════════════════════════════════════════

/**
 * GET /api/games/admin/rooms
 * Paginated list of GameRooms with optional filters.
 * Query params: gameName, status, mode, userId, page, limit
 */
router.get('/admin/rooms', adminAuth, async (req, res) => {
    try {
        const GameRoom = require('../models/GameRoom');
        const { gameName, status, mode, userId, page = 1, limit = 20 } = req.query;

        const filter = {};
        if (gameName) filter.gameName = gameName;
        if (status)   filter.status   = status;
        if (mode)     filter.mode     = mode;
        if (userId)   filter['players.userId'] = userId;

        const pageNum  = Math.max(1, parseInt(page)  || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
        const skip     = (pageNum - 1) * limitNum;

        const [rooms, total] = await Promise.all([
            GameRoom.find(filter)
                .select('-state')    // exclude large game-state blob from list view
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            GameRoom.countDocuments(filter)
        ]);

        res.json({
            success: true,
            data: {
                rooms,
                total,
                page:       pageNum,
                totalPages: Math.ceil(total / limitNum),
                limit:      limitNum
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/games/admin/rooms/:roomId
 * Full room details plus the last 20 GameMove audit records.
 */
router.get('/admin/rooms/:roomId', adminAuth, async (req, res) => {
    try {
        const GameRoom = require('../models/GameRoom');
        const GameMove = require('../models/GameMove');

        const [room, moves] = await Promise.all([
            GameRoom.findById(req.params.roomId).lean(),
            GameMove.find({ roomId: req.params.roomId })
                .sort({ moveNumber: -1 })
                .limit(20)
                .lean()
        ]);

        if (!room) {
            return res.status(404).json({ success: false, message: 'Room not found.' });
        }

        res.json({ success: true, data: { room, moves } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/games/admin/rooms/:roomId/transactions
 * Transactions linked to this room.
 *
 * Matching strategy: idempotencyKey starts with
 *   room_entry_<roomId>_      — game_entry_fee (deduction on room creation)
 *   room_reward_<roomId>_     — game_reward   (human win payout)
 *   room_refund_<roomId>_     — game_cancel_refund (cancellation refund)
 *
 * Note: room_create_rollback_<attemptId>_<userId> transactions use a random
 * attemptId and cannot be matched by roomId (no room was persisted at that point).
 */
router.get('/admin/rooms/:roomId/transactions', adminAuth, async (req, res) => {
    try {
        const roomId = req.params.roomId;
        const txns = await Transaction.find({
            idempotencyKey: { $regex: `^room_(entry|reward|refund)_${roomId}` }
        })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

        res.json({ success: true, data: { transactions: txns, total: txns.length } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/games/admin/rooms/:roomId/cancel
 * Admin-cancel a waiting/active/paused room and refund all human players.
 * Idempotent: RoomManager.cancelRoom throws for already-finished rooms (returns 400).
 * Safe: completed/cancelled rooms are rejected — no double-refund possible.
 */
router.post('/admin/rooms/:roomId/cancel', adminAuth, async (req, res) => {
    try {
        const room = await RoomManager.cancelRoom(req.params.roomId, req.userId);
        res.json({
            success: true,
            message: 'Room cancelled and players refunded.',
            data: {
                roomId:       room._id,
                status:       room.status,
                cancelReason: room.cancelReason
            }
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// ══════════════════════════════════════════════════════════
// ROOM ROUTES  (Carrom / Ludo — turn-based games)
// NOTE: Flappy Bird and Fruit Ninja do NOT use these routes.
//       They continue to use /queue, /match, and /subscription routes above.
// ══════════════════════════════════════════════════════════

/**
 * POST /api/games/room/create
 * Create a new Carrom or Ludo room.
 * Bot mode: room is immediately active.
 * Online mode: room waits for a 2nd player to join.
 */
router.post('/room/create', auth, requireVerified, async (req, res) => {
    try {
        const { gameName, entryFee, mode, difficulty } = req.body;
        const room = await RoomManager.createRoom(
            req.userId, gameName, entryFee, mode, difficulty
        );
        res.status(201).json({
            success: true,
            message: room.status === 'active'
                ? 'Room created and game started!'
                : `Room created. Share code: ${room.roomCode}`,
            data: {
                roomId:   room._id,
                roomCode: room.roomCode,
                status:   room.status,
                gameName: room.gameName,
                mode:     room.mode,
                entryFee: room.entryFee,
                players:  room.players
            }
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/games/room/join
 * Join an existing online waiting room by roomCode.
 */
router.post('/room/join', auth, requireVerified, async (req, res) => {
    try {
        const { roomCode } = req.body;
        if (!roomCode) return res.status(400).json({ success: false, message: 'roomCode is required' });

        const room = await RoomManager.joinRoom(req.userId, roomCode);
        res.json({
            success: true,
            message: room.status === 'active' ? 'Game starting!' : 'Joined room.',
            data: {
                roomId:   room._id,
                roomCode: room.roomCode,
                status:   room.status,
                gameName: room.gameName,
                entryFee: room.entryFee,
                players:  room.players
            }
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/games/room/leave
 * Leave or forfeit an active room.
 * Phase 1: cancels the room and refunds all players.
 * TODO (Phase 2+): implement forfeit logic when game engines are live.
 */
router.post('/room/leave', auth, async (req, res) => {
    try {
        const { roomId } = req.body;
        if (!roomId) return res.status(400).json({ success: false, message: 'roomId is required' });

        const room = await RoomManager.leaveRoom(req.userId, roomId);
        res.json({
            success: true,
            message: 'Left the room.',
            data: { roomId: room._id, status: room.status, cancelReason: room.cancelReason }
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/games/rooms/active
 * Get the calling user's active room (if any), plus count.
 */
router.get('/rooms/active', auth, async (req, res) => {
    try {
        const room = await require('../models/GameRoom').getActiveForUser(req.userId);
        res.json({
            success: true,
            data: {
                hasActiveRoom: !!room,
                room: room || null
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /api/games/rooms/history
 * Paginated room history for the calling user.
 * Query params:
 *   gameName  — optional filter ('carrom' | 'ludo')
 *   limit     — max 50, default 20
 *   skip      — offset for pagination
 *
 * Each entry in rooms[] includes derived fields:
 *   isWin        — true when winnerId matches the calling user
 *   isPractice   — true when entryFee === 0
 *   resultLabel  — 'Won' | 'Lost' | 'Timed Out' | 'Forfeited' | 'Cancelled'
 */
router.get('/rooms/history', auth, async (req, res) => {
    try {
        const GameRoom  = require('../models/GameRoom');
        const limit     = Math.min(parseInt(req.query.limit) || 20, 50);
        const skip      = parseInt(req.query.skip) || 0;
        const gameName  = req.query.gameName || null;
        const userId    = req.userId.toString();

        const query = {
            'players.userId': req.userId,
            status: { $in: ['completed', 'cancelled', 'abandoned'] }
        };
        if (gameName) query.gameName = gameName;

        const [rawRooms, total] = await Promise.all([
            GameRoom.find(query)
                .select('-state')          // exclude large game-state blob
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            GameRoom.countDocuments(query)
        ]);

        const rooms = rawRooms.map(room => {
            const isWin      = !!(room.winnerId && room.winnerId.toString() === userId);
            const isPractice = room.entryFee === 0;
            // resultLabel derivation for completed / cancelled / abandoned rooms.
            // Covers all terminal cancelReason values across bot and online modes:
            //   'forfeit'            — human left a paid bot room mid-game (status: completed)
            //   'turn_timeout'       — human timed out their turn (status: completed or cancelled)
            //   'disconnect_forfeit' — human disconnected from online room; opponent wins (status: completed)
            //   'abandoned'          — both online players disconnected (status: abandoned)
            //   'disconnect_before_start' / 'user_cancelled_search' / 'admin_cancel' / 'waiting_timeout'
            //                        — lobby-level cancellation (status: cancelled)
            const resultLabel =
                (room.cancelReason === 'turn_timeout')
                    ? 'Timed Out'
                    : (room.cancelReason === 'forfeit')
                        ? 'Forfeited'
                    : (!isWin && room.cancelReason === 'disconnect_forfeit')
                        ? 'Forfeited'
                    : (room.status === 'cancelled' || room.status === 'abandoned')
                        ? 'Cancelled'
                    : isWin ? 'Won' : 'Lost';

            return {
                roomId:            room._id,
                roomCode:          room.roomCode,
                gameName:          room.gameName,
                mode:              room.mode,
                entryFee:          room.entryFee,
                totalPool:         room.totalPool,
                status:            room.status,
                winnerId:          room.winnerId,
                winnerUsername:    room.winnerUsername,
                winnerPrize:       room.winnerPrize,
                platformFee:       room.platformFee,
                cancelReason:      room.cancelReason,
                stateVersion:      room.stateVersion,
                rewardDistributed: room.rewardDistributed,
                createdAt:         room.createdAt,
                completedAt:       room.completedAt,
                cancelledAt:       room.cancelledAt,
                isWin,
                isPractice,
                resultLabel,
            };
        });

        res.json({
            success: true,
            data: { rooms, total, limit, skip, gameName: gameName || null }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /api/games/room/:id/cancel
 * Admin: cancel any non-finished room and refund all players.
 */
router.post('/room/:id/cancel', adminAuth, async (req, res) => {
    try {
        const room = await RoomManager.cancelRoom(req.params.id, req.userId);
        res.json({
            success: true,
            message: 'Room cancelled and players refunded.',
            data: { roomId: room._id, status: room.status, cancelReason: room.cancelReason }
        });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

module.exports = router;
