'use strict';

/**
 * RoomManager — Create, join, leave, cancel, and query GameRooms.
 *
 * Used exclusively for turn-based games: Carrom and Ludo.
 * Flappy Bird and Fruit Ninja use QueueManager + MatchManager instead.
 *
 * Wallet rules (same atomic pattern as QueueManager._createMatchFromBatch):
 *   - Entry fee deducted via User.findOneAndUpdate with $gte guard.
 *   - If any step after deduction throws, the fee is refunded immediately.
 *   - Every deduction and refund creates a Transaction record with an idempotencyKey.
 */
const crypto = require('crypto');
const GameRoom      = require('../models/GameRoom');
const GameSettings  = require('../models/GameSettings');
const User          = require('../../models/User');
const Transaction   = require('../../models/Transaction');
const logger        = require('../../utils/logger');
const { emitToMatch } = require('../../utils/helpers');
const carromEngine  = require('../engines/carromEngine');

// Strictly the games that use the GameRoom / turn-based system.
// flappy-bird and fruit-ninja must NEVER appear here.
const ROOM_GAMES = ['carrom', 'ludo'];

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a random 6-character room code from an unambiguous alphabet
 * (no I, O, 0, 1 to prevent visual confusion on mobile).
 */
function makeRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

/**
 * Attempt to generate a roomCode that doesn't exist in the DB.
 * Retries up to maxAttempts times (collision probability is negligible at scale).
 */
async function uniqueRoomCode(maxAttempts = 5) {
    for (let i = 0; i < maxAttempts; i++) {
        const code = makeRoomCode();
        const exists = await GameRoom.findOne({ roomCode: code }).lean();
        if (!exists) return code;
    }
    throw new Error('Unable to generate a unique room code. Please try again.');
}

// ─── RoomManager ──────────────────────────────────────────────────────────────

class RoomManager {

    // ──────────────────────────────────────────────────────────────────────────
    // createRoom
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Create a new game room for Carrom or Ludo.
     *
     * @param {string|ObjectId} userId
     * @param {string} gameName  'carrom' | 'ludo'
     * @param {number} entryFee  Must be 0 or in GameSettings.entryFeeTiers
     * @param {string} mode      'bot' | 'online'
     * @param {string} difficulty 'easy' | 'medium' | 'hard' (bot mode only)
     * @returns {GameRoom}
     */
    static async createRoom(userId, gameName, entryFee, mode = 'bot', difficulty = 'medium') {
        // ── Validation ─────────────────────────────────────────────────────
        if (!ROOM_GAMES.includes(gameName)) {
            throw new Error(
                `"${gameName}" does not use the room system. ` +
                `Only ${ROOM_GAMES.join(', ')} are supported here.`
            );
        }
        if (!['bot', 'online'].includes(mode)) {
            throw new Error('Invalid mode. Must be "bot" or "online".');
        }
        if (!['easy', 'medium', 'hard'].includes(difficulty)) {
            throw new Error('Invalid difficulty. Must be "easy", "medium", or "hard".');
        }

        const fee = Math.round((parseFloat(entryFee) || 0) * 100) / 100; // round to 2dp
        if (isNaN(fee) || fee < 0) throw new Error('Entry fee must be a non-negative number.');

        // ── Settings ────────────────────────────────────────────────────────
        const settings = await GameSettings.getForGame(gameName);

        // Carrom free-practice (bot mode, zero entry fee) is always allowed
        // even when the game is marked inactive (coming soon for paid play).
        const isCarromFreePractice =
            gameName === 'carrom' && mode === 'bot' && fee === 0;

        if (!settings.isActive && !isCarromFreePractice) {
            throw new Error(`${settings.displayName} is not available yet. Stay tuned!`);
        }

        // Validate entry fee against allowed tiers.
        // Free-practice (fee === 0) is always exempt.
        // For paid rooms: fee must appear in the configured tier list.
        // If the tier list is empty, no paid play is allowed (admins must configure it first).
        if (!isCarromFreePractice && fee > 0) {
            const tiers = settings.entryFeeTiers || [];
            if (tiers.length === 0 || !tiers.includes(fee)) {
                throw new Error(
                    `Invalid entry fee $${fee.toFixed(2)}. ` +
                    (tiers.length > 0
                        ? `Allowed: ${tiers.filter(t => t > 0).map(t => `$${t}`).join(', ')}.`
                        : 'No paid entry fee tiers are configured for this game.')
                );
            }
        }

        // Paid bot mode requires explicit admin enablement via GameSettings.botModeEnabled.
        // Free practice (fee === 0) is always allowed regardless of this flag.
        if (mode === 'bot' && fee > 0 && !settings.botModeEnabled) {
            throw new Error('Paid bot mode is not currently available for this game.');
        }

        // ── User validation ─────────────────────────────────────────────────
        const user = await User.findById(userId).lean();
        if (!user) throw new Error('User not found.');
        if (user.status === 'suspended' || user.status === 'banned') {
            throw new Error('Account is not eligible to play.');
        }
        if (!user.hasPaidVerificationFee) {
            throw new Error('Account must be verified to play games.');
        }

        // Prevent double-room (user already in a waiting/active/paused room)
        const existingRoom = await GameRoom.getActiveForUser(userId);
        if (existingRoom) {
            throw new Error(
                `You already have an active ${existingRoom.gameName} room ` +
                `(${existingRoom.roomCode}). Please finish or leave it first.`
            );
        }

        // ── Wallet deduction ────────────────────────────────────────────────
        const attemptId = crypto.randomBytes(8).toString('hex');
        let walletDeducted = false;

        try {
            if (fee > 0) {
                const deducted = await User.findOneAndUpdate(
                    { _id: userId, 'wallet.balance': { $gte: fee } },
                    { $inc: { 'wallet.balance': -fee } }
                );
                if (!deducted) {
                    throw new Error(
                        `Insufficient balance. Entry fee is $${fee.toFixed(2)}.`
                    );
                }
                walletDeducted = true;
                logger.info('ROOM', `$${fee} deducted from ${user.username} for ${gameName} room`);
            }

            // ── Build players list ──────────────────────────────────────────
            const players = [
                {
                    userId,
                    username: user.username,
                    color: 'white',   // carrom: human = white pucks
                    isBot: false,
                    difficulty: 'medium',
                    isConnected: false,
                    connectedAt: null,
                    disconnectedAt: null,
                    score: 0,
                    hasFinished: false,
                    rank: 0
                }
            ];

            if (mode === 'bot') {
                players.push({
                    userId: null,
                    username: 'Robot',
                    color: 'black',   // carrom: bot = black pucks
                    isBot: true,
                    difficulty,
                    isConnected: false,
                    connectedAt: null,
                    disconnectedAt: null,
                    score: 0,
                    hasFinished: false,
                    rank: 0
                });
            }

            // ── Financial snapshot ──────────────────────────────────────────
            const humanPlayers = 1; // only creator at this point
            const totalPool   = parseFloat((fee * humanPlayers).toFixed(2));
            const winnerPct   = settings.winnerPercentage;

            // ── Waiting timeout (online mode) ───────────────────────────────
            const waitingTimeoutAt = mode === 'online'
                ? new Date(Date.now() + 2 * 60 * 1000) // 2 minutes
                : null;

            // ── Create the room ─────────────────────────────────────────────
            const roomCode = await uniqueRoomCode();

            // ── Initial game state (Carrom only) ────────────────────────────
            let initialState        = null;
            let initialTurnUserId   = null;

            if (gameName === 'carrom' && mode === 'bot') {
                initialState      = carromEngine.createInitialState(userId.toString(), 'bot');
                initialTurnUserId = userId;   // human always has first move
            }

            const room = await GameRoom.create({
                gameName,
                roomCode,
                status: mode === 'bot' ? 'active' : 'waiting',
                mode,
                entryFee: fee,
                totalPool,
                platformFee: 0,  // calculated on completion
                winnerPrize: 0,  // calculated on completion
                winnerPct,
                players,
                currentTurnUserId: initialTurnUserId,
                turnStartedAt:     initialTurnUserId ? new Date() : null,
                turnTimeoutSeconds: settings.turnTimeoutSeconds || 30,
                state:        initialState,
                stateVersion: 0,
                waitingTimeoutAt,
                settings: {
                    winnerPercentage:        settings.winnerPercentage,
                    turnTimeoutSeconds:      settings.turnTimeoutSeconds      || 30,
                    reconnectTimeoutSeconds: settings.reconnectTimeoutSeconds || 60,
                    matchTimeoutMinutes:     settings.matchTimeoutMinutes     || 30
                }
            });

            // ── Transaction record ──────────────────────────────────────────
            if (fee > 0) {
                await Transaction.create({
                    userId,
                    type: 'game_entry_fee',
                    amount: -fee,
                    status: 'completed',
                    description:
                        `${settings.displayName} room entry — Room ${room.roomCode}`,
                    processedAt: new Date(),
                    idempotencyKey: `room_entry_${room._id}_${userId}`
                });
            }

            logger.info(
                'ROOM',
                `Room ${room.roomCode} created for ${gameName} by ${user.username} ` +
                `[mode: ${mode}, fee: $${fee}, status: ${room.status}]`
            );

            return room;

        } catch (err) {
            // ── Rollback wallet if deducted but room creation failed ────────
            if (walletDeducted && fee > 0) {
                try {
                    await User.findByIdAndUpdate(userId, {
                        $inc: { 'wallet.balance': fee }
                    });
                    await Transaction.create({
                        userId,
                        type: 'game_cancel_refund',
                        amount: fee,
                        status: 'completed',
                        description: `${gameName} room creation failed — entry fee refund`,
                        processedAt: new Date(),
                        idempotencyKey: `room_create_rollback_${attemptId}_${userId}`
                    });
                    logger.warn(
                        'ROOM',
                        `Rolled back $${fee} to ${userId} — room creation failed: ${err.message}`
                    );
                } catch (refundErr) {
                    logger.error(
                        'ROOM',
                        `CRITICAL: Rollback refund failed for ${userId} (attempt ${attemptId}): ` +
                        `${refundErr.message}. Manual review required.`
                    );
                }
            }
            throw err;
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // joinRoom
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Join an existing online waiting room by roomCode.
     *
     * @param {string|ObjectId} userId
     * @param {string} roomCode  6-character code
     * @returns {GameRoom}  Updated room (may now be 'active')
     */
    static async joinRoom(userId, roomCode) {
        if (!roomCode) throw new Error('roomCode is required.');

        const room = await GameRoom.getWaitingByCode(roomCode);
        if (!room) {
            throw new Error(
                'Room not found or no longer available. ' +
                'It may have already started or been cancelled.'
            );
        }
        if (room.mode !== 'online') {
            throw new Error('Cannot join a bot room.');
        }
        if (room.players.length >= 2) {
            throw new Error('This room is already full.');
        }

        // Prevent rejoining own room
        const already = room.players.some(
            p => p.userId && p.userId.toString() === userId.toString()
        );
        if (already) {
            throw new Error('You are already in this room.');
        }

        // ── User validation ─────────────────────────────────────────────────
        const user = await User.findById(userId).lean();
        if (!user) throw new Error('User not found.');
        if (user.status === 'suspended' || user.status === 'banned') {
            throw new Error('Account is not eligible to play.');
        }
        if (!user.hasPaidVerificationFee) {
            throw new Error('Account must be verified to play games.');
        }

        // Prevent double-room
        const existingRoom = await GameRoom.getActiveForUser(userId);
        if (existingRoom) {
            throw new Error(
                `You already have an active room (${existingRoom.roomCode}). ` +
                'Please finish or leave it first.'
            );
        }

        const fee = room.entryFee;
        const attemptId = crypto.randomBytes(8).toString('hex');
        let walletDeducted = false;

        try {
            // ── Wallet deduction ────────────────────────────────────────────
            if (fee > 0) {
                const deducted = await User.findOneAndUpdate(
                    { _id: userId, 'wallet.balance': { $gte: fee } },
                    { $inc: { 'wallet.balance': -fee } }
                );
                if (!deducted) {
                    throw new Error(`Insufficient balance. Entry fee is $${fee.toFixed(2)}.`);
                }
                walletDeducted = true;
            }

            // ── Add joiner to room ──────────────────────────────────────────
            room.players.push({
                userId,
                username: user.username,
                color: 'blue',
                isBot: false,
                difficulty: 'medium',
                isConnected: false,
                connectedAt: null,
                disconnectedAt: null,
                score: 0,
                hasFinished: false,
                rank: 0
            });

            room.totalPool = parseFloat((room.totalPool + fee).toFixed(2));

            // If 2 human players are now present, activate the room
            const humanCount = room.players.filter(p => !p.isBot).length;
            if (humanCount >= 2) {
                room.status = 'active';
                room.waitingTimeoutAt = null;
                // Initialise game state so both clients can start playing immediately.
                if (room.gameName === 'carrom') {
                    const p1Id = room.players[0].userId.toString();
                    const p2Id = room.players[1].userId.toString();
                    room.state            = carromEngine.createInitialState(p1Id, p2Id);
                    room.currentTurnUserId = room.players[0].userId; // creator (white) goes first
                    room.turnStartedAt    = new Date();
                } else if (room.gameName === 'ludo') {
                    // Red = creator (player[0]), Blue = joiner (player[1])
                    const ludoEngine = require('../engines/ludoEngine');
                    const redId  = room.players[0].userId.toString();
                    const blueId = room.players[1].userId.toString();
                    room.state            = ludoEngine.createInitialState(redId, blueId);
                    room.currentTurnUserId = room.players[0].userId; // red goes first
                    room.turnStartedAt    = new Date();
                    // Assign colors in player records
                    room.players[0].color = 'red';
                    room.players[1].color = 'blue';
                }
            }

            await room.save();

            // ── Transaction record ──────────────────────────────────────────
            if (fee > 0) {
                await Transaction.create({
                    userId,
                    type: 'game_entry_fee',
                    amount: -fee,
                    status: 'completed',
                    description:
                        `${room.gameName} room join — Room ${room.roomCode}`,
                    processedAt: new Date(),
                    idempotencyKey: `room_entry_${room._id}_${userId}`
                });
            }

            logger.info(
                'ROOM',
                `${user.username} joined room ${room.roomCode} [${room.gameName}]` +
                (room.status === 'active' ? ' — game starting' : '')
            );

            return room;

        } catch (err) {
            // ── Rollback if needed ──────────────────────────────────────────
            if (walletDeducted && fee > 0) {
                try {
                    await User.findByIdAndUpdate(userId, { $inc: { 'wallet.balance': fee } });
                    await Transaction.create({
                        userId,
                        type: 'game_cancel_refund',
                        amount: fee,
                        status: 'completed',
                        description: `${room.gameName} room join failed — entry fee refund`,
                        processedAt: new Date(),
                        idempotencyKey: `room_join_rollback_${attemptId}_${userId}`
                    });
                    logger.warn(
                        'ROOM',
                        `Rolled back $${fee} to ${userId} — room join failed: ${err.message}`
                    );
                } catch (refundErr) {
                    logger.error(
                        'ROOM',
                        `CRITICAL: Join rollback failed for ${userId}: ${refundErr.message}`
                    );
                }
            }
            throw err;
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // leaveRoom
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * A player leaves or abandons a room.
     *
     * - Waiting room: cancel + refund creator.
     * - Active room (Phase 1 safe behavior): cancel + refund all players.
     *
     * TODO (Phase 2+): implement proper forfeit — award win to remaining opponent,
     *   call RewardEngine.distributeReward, emit game:match:end to the room.
     *
     * @param {string|ObjectId} userId
     * @param {string|ObjectId} roomId
     * @returns {GameRoom}
     */
    static async leaveRoom(userId, roomId) {
        const room = await GameRoom.findById(roomId);
        if (!room) throw new Error('Room not found.');

        const isParticipant = room.players.some(
            p => p.userId && p.userId.toString() === userId.toString()
        );
        if (!isParticipant) {
            throw new Error('You are not a participant in this room.');
        }
        if (['completed', 'cancelled', 'abandoned'].includes(room.status)) {
            throw new Error('This room is already finished.');
        }

        if (room.status === 'waiting') {
            await this._cancelAndRefundRoom(room, 'forfeit');
            logger.info('ROOM', `Room ${room.roomCode} cancelled — creator left waiting room`);
        } else {
            // Active or paused:
            // Paid bot rooms where the game has started → forfeit (platform keeps pool).
            // Free practice or paid room that never started (stateVersion === 0) → refund.
            if (room.mode === 'bot' && room.entryFee > 0 && room.stateVersion > 0) {
                await this.forfeitBotRoom(room);
                logger.info(
                    'ROOM',
                    `Paid bot room ${room.roomCode} forfeited — player left mid-game`
                );
            } else {
                await this._cancelAndRefundRoom(room, 'forfeit');
                logger.info(
                    'ROOM',
                    `Room ${room.roomCode} cancelled — player left active room (refunded)`
                );
            }
        }

        return room;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // cancelRoom  (admin only)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Admin cancels any non-finished room and refunds all non-bot players.
     *
     * @param {string|ObjectId} roomId
     * @param {string|ObjectId} adminId  For logging only
     * @returns {GameRoom}
     */
    static async cancelRoom(roomId, adminId) {
        const room = await GameRoom.findById(roomId);
        if (!room) throw new Error('Room not found.');

        if (['completed', 'cancelled', 'abandoned'].includes(room.status)) {
            throw new Error('Room is already finished and cannot be cancelled.');
        }

        await this._cancelAndRefundRoom(room, 'admin_cancel');
        logger.info('ROOM', `Room ${room.roomCode} cancelled by admin ${adminId}`);
        return room;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // getActiveRooms  (admin / internal use)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * List waiting / active / paused rooms, optionally filtered by gameName.
     *
     * @param {string|null} gameName  Filter to specific game, or null for all
     * @param {number} limit
     * @param {number} skip
     * @returns {{ rooms, total, limit, skip }}
     */
    static async getActiveRooms(gameName, limit = 20, skip = 0) {
        const query = {
            status: { $in: ['waiting', 'active', 'paused'] }
        };
        if (gameName && ROOM_GAMES.includes(gameName)) {
            query.gameName = gameName;
        }

        const [rooms, total] = await Promise.all([
            GameRoom.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            GameRoom.countDocuments(query)
        ]);

        return { rooms, total, limit, skip };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // getUserRoomHistory
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Paginated room history for a specific user.
     *
     * @param {string|ObjectId} userId
     * @param {number} limit
     * @param {number} skip
     * @returns {{ rooms, total, limit, skip }}
     */
    static async getUserRoomHistory(userId, limit = 20, skip = 0) {
        const query = {
            'players.userId': userId,
            status: { $in: ['completed', 'cancelled', 'abandoned'] }
        };

        const [rooms, total] = await Promise.all([
            GameRoom.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            GameRoom.countDocuments(query)
        ]);

        return { rooms, total, limit, skip };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // reconnectUser
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Mark a player as reconnected and return the current room state snapshot.
     * Called when a socket emits 'game:reconnect'.
     *
     * @param {string|ObjectId} userId
     * @param {string|ObjectId} roomId
     * @returns {{ room, state, stateVersion, currentTurnUserId, turnTimeoutAt, players, finished }}
     */
    static async reconnectUser(userId, roomId) {
        const room = await GameRoom.findById(roomId);
        if (!room) throw new Error('Room not found.');

        const playerIndex = room.players.findIndex(
            p => p.userId && p.userId.toString() === userId.toString()
        );
        if (playerIndex === -1) {
            throw new Error('You are not a participant in this room.');
        }

        const finished = ['completed', 'cancelled', 'abandoned'].includes(room.status);

        if (!finished) {
            room.players[playerIndex].isConnected    = true;
            room.players[playerIndex].connectedAt    = new Date();
            room.players[playerIndex].disconnectedAt = null;
            if (room.status === 'paused') room.status = 'active';
            await room.save();
        }

        const turnTimeoutAt =
            room.turnStartedAt && room.turnTimeoutSeconds
                ? new Date(
                    room.turnStartedAt.getTime() + room.turnTimeoutSeconds * 1000
                  )
                : null;

        logger.info('ROOM', `Player ${userId} reconnected to room ${room.roomCode}`);

        return {
            room,
            state:              room.state,
            stateVersion:       room.stateVersion,
            currentTurnUserId:  room.currentTurnUserId,
            turnTimeoutAt,
            players:            room.players,
            finished
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // finalizeTimedOutRooms  (cron / admin)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Cancel every waiting room whose waitingTimeoutAt has passed.
     * Refunds non-bot players using the existing idempotent path.
     * Emits game:room:cancelled to the room channel if io is provided.
     *
     * @param {import('socket.io').Server|null} io  Main Socket.IO Server instance
     * @returns {number}  Count of rooms cancelled
     */
    static async finalizeTimedOutRooms(io = null) {
        const now = new Date();

        const expiredRooms = await GameRoom.find({
            status: 'waiting',
            waitingTimeoutAt: { $ne: null, $lte: now }
        });

        if (expiredRooms.length === 0) return 0;

        let cancelledCount = 0;

        for (const room of expiredRooms) {
            try {
                const refunded = await this._cancelAndRefundRoom(room, 'waiting_timeout');

                if (io) {
                    emitToMatch(io, room._id, 'game:room:cancelled', {
                        roomId:          room._id,
                        reason:          'waiting_timeout',
                        message:         'Room expired — no second player joined in time.',
                        refundedPlayers: refunded
                    });
                }

                cancelledCount++;
                logger.info(
                    'ROOM_CRON',
                    `Waiting room ${room.roomCode} (${room.gameName}) cancelled — waiting_timeout`
                );
            } catch (err) {
                logger.error(
                    'ROOM_CRON',
                    `Failed to cancel timed-out room ${room._id}: ${err.message}`
                );
            }
        }

        return cancelledCount;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // finalizeDisconnectedRooms  (cron / admin)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Cancel active/paused online rooms where a non-bot player has been
     * disconnected beyond their reconnect window (settings.reconnectTimeoutSeconds).
     *
     * Phase 1 safe behavior:
     *   - No game state exists (room.state is null), so we refund all players.
     *   - cancelReason: 'disconnect_timeout'
     *
     * TODO (Phase 2+): if room.stateVersion > 0 (actual moves were made),
     *   award the win to the still-connected player and call RewardEngine
     *   instead of issuing a blanket refund.
     *
     * @param {import('socket.io').Server|null} io  Main Socket.IO Server instance
     * @returns {number}  Count of rooms cancelled
     */
    static async finalizeDisconnectedRooms(io = null) {
        const now = Date.now();

        // Scope to online rooms only — bot rooms never need disconnect handling.
        const liveRooms = await GameRoom.find({
            status: { $in: ['active', 'paused'] },
            mode: 'online'
        });

        if (liveRooms.length === 0) return 0;

        let cancelledCount = 0;

        for (const room of liveRooms) {
            const reconnectMs =
                (room.settings && room.settings.reconnectTimeoutSeconds
                    ? room.settings.reconnectTimeoutSeconds
                    : 60) * 1000;

            const disconnectedPlayer = room.players.find(
                p =>
                    !p.isBot &&
                    p.userId &&
                    !p.isConnected &&
                    p.disconnectedAt &&
                    (now - p.disconnectedAt.getTime()) >= reconnectMs
            );

            if (!disconnectedPlayer) continue;

            try {
                const connectedOpponent = room.players.find(
                    p =>
                        !p.isBot &&
                        p.userId &&
                        p.userId.toString() !== disconnectedPlayer.userId.toString() &&
                        p.isConnected
                );

                if (room.stateVersion > 0 && connectedOpponent) {
                    // Game was underway, opponent still online → forfeit + pay opponent.
                    await this._forfeitOnlineRoom(
                        room,
                        connectedOpponent.userId,
                        connectedOpponent.username,
                        disconnectedPlayer.userId,
                        io
                    );
                } else if (room.stateVersion > 0) {
                    // Both offline after moves were made → abandon, no payout.
                    await GameRoom.findByIdAndUpdate(room._id, { $set: {
                        status:       'abandoned',
                        cancelledAt:  new Date(),
                        cancelReason: 'abandoned',
                    }});
                    if (io) {
                        emitToMatch(io, room._id, 'game:room:cancelled', {
                            roomId:  room._id,
                            reason:  'abandoned',
                            message: 'Room abandoned — both players disconnected.',
                        });
                    }
                    logger.info('ROOM_CRON', `Room ${room.roomCode} abandoned — both players offline`);
                } else {
                    // stateVersion === 0: no moves → safe to refund.
                    const refunded = await this._cancelAndRefundRoom(room, 'disconnect_before_start');
                    if (io) {
                        emitToMatch(io, room._id, 'game:room:cancelled', {
                            roomId:          room._id,
                            reason:          'disconnect_before_start',
                            message:         'Room closed — a player disconnected before the first move.',
                            refundedPlayers: refunded,
                        });
                    }
                    logger.info(
                        'ROOM_CRON',
                        `Room ${room.roomCode} cancelled — disconnect_before_start`
                    );
                }
                cancelledCount++;
            } catch (err) {
                logger.error(
                    'ROOM_CRON',
                    `Failed to finalize disconnected room ${room._id}: ${err.message}`
                );
            }
        }

        return cancelledCount;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // finalizeTurnTimeouts  (Phase 3B — cron / admin)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Find every active Carrom bot room where the human player's turn has
     * exceeded room.turnTimeoutSeconds without a shot being submitted, and
     * finalise it:
     *
     * Paid rooms (entryFee > 0):
     *   - Atomic findOneAndUpdate prevents a double-complete race between
     *     two concurrent cron ticks.
     *   - Bot wins; platform keeps totalPool (no payout, no refund).
     *   - status → 'completed', cancelReason → 'turn_timeout',
     *     rewardDistributed → true, winnerPrize → 0, platformFee → totalPool.
     *   - Emits game:match:end { forfeit:true, timeout:true, payout:0 }.
     *
     * Free-practice rooms (entryFee === 0):
     *   - Cancelled via _cancelAndRefundRoom (fee=0 → no wallet action).
     *   - Emits game:room:cancelled.
     *
     * @param {import('socket.io').Namespace|null} io  The /v2 Socket.IO namespace
     * @returns {number}  Count of rooms finalised
     */
    static async finalizeTurnTimeouts(io = null) {
        const now = Date.now();

        // Load active carrom bot rooms with a live human turn.
        // In-memory elapsed check avoids a $expr in the query; concurrent
        // paid bot rooms are rare so the scan is always tiny.
        const candidates = await GameRoom.find({
            status:            'active',
            mode:              'bot',
            gameName:          'carrom',
            rewardDistributed: false,
            currentTurnUserId: { $ne: null },
            turnStartedAt:     { $ne: null },
        });

        if (candidates.length === 0) return 0;

        let count = 0;

        for (const room of candidates) {
            const timeoutMs = (room.turnTimeoutSeconds || 30) * 1000;
            if (now - room.turnStartedAt.getTime() < timeoutMs) continue;

            const botPlayer = room.players.find(p => p.isBot);

            try {
                if (room.entryFee > 0) {
                    // ── Paid: atomic forfeit → bot wins, platform keeps pool ──
                    // findOneAndUpdate with status/rewardDistributed guards means
                    // only the first concurrent call wins; subsequent ones get null.
                    const updated = await GameRoom.findOneAndUpdate(
                        { _id: room._id, status: 'active', rewardDistributed: false },
                        { $set: {
                            status:            'completed',
                            completedAt:       new Date(),
                            cancelReason:      'turn_timeout',
                            winnerId:          null,
                            winnerUsername:    botPlayer?.username || 'Robot',
                            winnerPrize:       0,
                            platformFee:       room.totalPool,
                            rewardDistributed: true,
                        }},
                        { new: true }
                    );
                    if (!updated) continue;   // race: already handled by another call

                    if (io) {
                        io.to(`match:${room._id}`).emit('game:match:end', {
                            roomId:         room._id,
                            winnerId:       null,
                            winnerUsername: botPlayer?.username || 'Robot',
                            isPractice:     false,
                            payout:         0,
                            platformFee:    room.totalPool,
                            finalState:     room.state,
                            forfeit:        true,
                            timeout:        true,
                        });
                    }

                    logger.info(
                        'ROOM_CRON',
                        `Paid bot room ${room.roomCode} turn-timeout — ` +
                        `platform keeps $${room.totalPool}`
                    );
                } else {
                    // ── Free practice: cancel (no wallet action) ─────────────
                    await this._cancelAndRefundRoom(room, 'turn_timeout');

                    if (io) {
                        io.to(`match:${room._id}`).emit('game:room:cancelled', {
                            roomId:  room._id,
                            reason:  'turn_timeout',
                            message: 'Your turn timed out — practice match cancelled.',
                        });
                    }

                    logger.info(
                        'ROOM_CRON',
                        `Free-practice bot room ${room.roomCode} cancelled — turn_timeout`
                    );
                }

                count++;
            } catch (err) {
                logger.error(
                    'ROOM_CRON',
                    `finalizeTurnTimeouts failed for room ${room._id}: ${err.message}`
                );
            }
        }

        return count;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // forfeitBotRoom  (Phase 3)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Forfeit a paid bot room mid-game: bot wins, platform keeps the pool.
     * Called when the human player disconnects or leaves a paid bot game in progress.
     *
     * No wallet credit: the platform retains totalPool as revenue.
     * Sets rewardDistributed = true so distributeRoomReward never fires afterwards.
     *
     * @param {GameRoom} room  Mongoose document (not lean)
     * @returns {GameRoom}
     */
    static async forfeitBotRoom(room) {
        const botPlayer = room.players.find(p => p.isBot);

        // Atomic update: only proceeds if the room is still active and unrewarded.
        // Guards against a concurrent distributeRoomReward call (e.g. bot shot completes
        // at the same instant the human player disconnects).
        const updated = await GameRoom.findOneAndUpdate(
            { _id: room._id, status: 'active', rewardDistributed: false },
            { $set: {
                status:            'completed',
                completedAt:       new Date(),
                cancelReason:      'forfeit',
                winnerId:          null,                  // bot has no userId
                winnerUsername:    botPlayer?.username || 'Robot',
                winnerPrize:       0,
                platformFee:       room.totalPool,
                rewardDistributed: true,                  // bot win = no payout
            }},
            { new: true }
        );

        if (!updated) {
            // Another call (e.g. distributeRoomReward for a concurrent winning shot)
            // already completed this room — nothing to do.
            logger.warn(
                'ROOM',
                `forfeitBotRoom skipped for room ${room.roomCode} — already completed/rewarded`
            );
            return room;   // return original, cancelReason unchanged so callers can detect skip
        }

        // Sync in-memory document so callers (leaveRoom, disconnect handler) can read
        // the final values without re-fetching from the DB.
        room.status            = updated.status;
        room.completedAt       = updated.completedAt;
        room.cancelReason      = updated.cancelReason;
        room.winnerId          = updated.winnerId;
        room.winnerUsername    = updated.winnerUsername;
        room.winnerPrize       = updated.winnerPrize;
        room.platformFee       = updated.platformFee;
        room.rewardDistributed = updated.rewardDistributed;

        logger.info(
            'ROOM',
            `Paid bot room ${room.roomCode} forfeited — platform keeps $${room.totalPool}`
        );
        return room;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // distributeRoomReward  (Phase 3)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Distribute the winner prize for a completed paid room (bot or online mode).
     *
     * Safety guarantees:
     *   - Idempotent: returns immediately if room.rewardDistributed is already true.
     *   - Idempotent: uses a per-room idempotencyKey on the Transaction so a DB retry
     *     cannot double-credit the wallet.
     *   - Free practice rooms (entryFee === 0): never called; but harmless if called.
     *   - Bot win (room.winnerId === null): records platformFee, sets rewardDistributed.
     *     No wallet credit issued.
     *   - Transaction description is mode-aware: "carrom bot room win" or
     *     "carrom online room win" depending on room.mode.
     *
     * @param {GameRoom} room  Mongoose document (not lean) — must have status 'completed'
     * @returns {{ prize: number, platformFee: number, skipped?: boolean }}
     */
    static async distributeRoomReward(room) {
        // Primary idempotency guard
        if (room.rewardDistributed) {
            logger.warn('ROOM_REWARD', `distributeRoomReward called twice for room ${room.roomCode} — skipped`);
            return { skipped: true, prize: room.winnerPrize, platformFee: room.platformFee };
        }

        const winnerPct  = (room.settings && room.settings.winnerPercentage) || room.winnerPct || 70;
        const pool       = room.totalPool || 0;
        const prize      = parseFloat((pool * winnerPct / 100).toFixed(2));
        const platFee    = parseFloat((pool - prize).toFixed(2));

        if (room.winnerId) {
            // Human won — credit wallet with winnerPct of pool; platform keeps remainder.
            room.winnerPrize = prize;
            room.platformFee = platFee;

            const ikey = `room_reward_${room._id}_${room.winnerId}`;
            const alreadyPaid = await Transaction.findOne({ idempotencyKey: ikey }).lean();
            if (!alreadyPaid) {
                await User.findByIdAndUpdate(room.winnerId, {
                    $inc: { 'wallet.balance': prize, 'wallet.totalEarned': prize }
                });
                await Transaction.create({
                    userId:         room.winnerId,
                    type:           'game_reward',
                    amount:         prize,
                    status:         'completed',
                    description:
                        `${room.gameName} ${room.mode === 'online' ? 'online' : 'bot'} room win — ` +
                        `Room ${room.roomCode}, Pool: $${pool.toFixed(2)}, Prize: $${prize.toFixed(2)}`,
                    processedAt:    new Date(),
                    idempotencyKey: ikey,
                });
                logger.info(
                    'ROOM_REWARD',
                    `$${prize} credited to ${room.winnerId} — room ${room.roomCode}`
                );
            } else {
                logger.warn(
                    'ROOM_REWARD',
                    `Duplicate reward blocked for ${room.winnerId} in room ${room.roomCode}`
                );
            }
        } else {
            // Bot won — platform keeps the entire pool; no wallet credit issued.
            // winnerPrize stays 0 so game:match:end sends payout:0 to client.
            room.winnerPrize = 0;
            room.platformFee = pool;
            logger.info(
                'ROOM_REWARD',
                `Bot won room ${room.roomCode} — platform keeps $${pool} (prize: $0)`
            );
        }

        room.rewardDistributed = true;
        await room.save();

        return { prize: room.winnerPrize, platformFee: room.platformFee };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // findOrCreateOnlineRoom  (OM1 — Carrom auto-matchmaking)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Auto-matchmaking entry point for online Carrom.
     *
     * Behavior:
     *   1. Validate settings (isActive, entryFeeTiers).
     *   2. Guard against double-room for this user.
     *   3. Find the oldest valid waiting online room with the same fee that was
     *      NOT created by this user.
     *   4a. If found  → joinRoom (wallet deducted, room activated, state initialised).
     *   4b. If not    → createRoom(mode='online') (wallet deducted, waiting).
     *
     * Expired waiting rooms (waitingTimeoutAt <= now) are silently skipped;
     * finalizeTimedOutRooms() handles their refunds on the next cron tick.
     *
     * Race condition note: two simultaneous first-time callers may each create
     * their own waiting room. Both rooms are valid — they will be matched when
     * the next user searches. A MongoDB transaction would eliminate this
     * window but is not required for a single-instance Railway deployment.
     *
     * @param {string|ObjectId} userId
     * @param {string} gameName  Must be 'carrom' for OM1
     * @param {number} entryFee  Must be 0 or in GameSettings.entryFeeTiers
     * @returns {{ room, matched: boolean, waiting: boolean, message: string }}
     */
    static async findOrCreateOnlineRoom(userId, gameName, entryFee) {
        if (!ROOM_GAMES.includes(gameName)) {
            throw new Error(
                `Online multiplayer is not available for "${gameName}". ` +
                `Supported games: ${ROOM_GAMES.join(', ')}.`
            );
        }

        const fee = Math.round((parseFloat(entryFee) || 0) * 100) / 100;
        if (isNaN(fee) || fee < 0) throw new Error('Entry fee must be a non-negative number.');

        // ── Settings validation ────────────────────────────────────────────────
        const settings = await GameSettings.getForGame(gameName);
        if (!settings.isActive) {
            throw new Error(`${settings.displayName} is not available yet. Stay tuned!`);
        }
        if (fee > 0) {
            const tiers = settings.entryFeeTiers || [];
            if (tiers.length === 0 || !tiers.includes(fee)) {
                throw new Error(
                    `Invalid entry fee $${fee.toFixed(2)}. ` +
                    (tiers.length > 0
                        ? `Allowed: ${tiers.filter(t => t > 0).map(t => `$${t}`).join(', ')}.`
                        : 'No paid entry fee tiers are configured for this game.')
                );
            }
        }

        // ── Double-room guard ──────────────────────────────────────────────────
        const existingRoom = await GameRoom.getActiveForUser(userId);
        if (existingRoom) {
            throw new Error(
                `You already have an active ${existingRoom.gameName} room ` +
                `(${existingRoom.roomCode}). Please finish or leave it first.`
            );
        }

        // ── Find the oldest valid waiting online room ──────────────────────────
        // Exclude expired rooms (waitingTimeoutAt <= now) — the cron will refund those.
        // Exclude rooms that already contain this user ($ne on players.userId array).
        const now = new Date();
        const waitingRoom = await GameRoom.findOne({
            gameName,
            mode:             'online',
            status:           'waiting',
            entryFee:         fee,
            waitingTimeoutAt: { $gt: now },
            'players.userId': { $ne:  userId },
        }).sort({ createdAt: 1 });   // FIFO: join oldest waiting room first

        if (waitingRoom) {
            // User B joins the existing waiting room; joinRoom handles wallet deduction,
            // room activation, and game state initialisation for carrom.
            const room = await this.joinRoom(userId, waitingRoom.roomCode);
            return {
                room,
                matched: room.status === 'active',
                waiting: room.status === 'waiting',
                message: room.status === 'active'
                    ? 'Opponent found! Game starting.'
                    : 'Joined waiting room.',
            };
        }

        // ── No match found — create a new waiting room (User A slot) ──────────
        const room = await this.createRoom(userId, gameName, fee, 'online');
        return {
            room,
            matched: false,
            waiting: true,
            message: 'Waiting for opponent...',
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // cancelOnlineSearch  (OM1 — cancel waiting room while matchmaking)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Cancel a waiting online room that this user is holding while searching
     * for an opponent. Refunds the entry fee via the existing idempotent path.
     *
     * Guards:
     *   - Room must exist and be in 'waiting' status.
     *   - Room must be mode='online'.
     *   - Requesting user must be a participant.
     *   - Active/paused rooms are rejected — cannot cancel a live game this way.
     *
     * @param {string|ObjectId} userId
     * @param {string|ObjectId} roomId
     * @returns {GameRoom}
     */
    static async cancelOnlineSearch(userId, roomId) {
        if (!roomId) throw new Error('roomId is required.');

        const room = await GameRoom.findById(roomId);
        if (!room) throw new Error('Room not found.');

        if (room.mode !== 'online') {
            throw new Error('Cannot cancel a bot room via this method. Use game:room:leave instead.');
        }
        if (room.status !== 'waiting') {
            if (['active', 'paused'].includes(room.status)) {
                throw new Error(
                    'Game is already in progress. ' +
                    'Use game:room:leave to forfeit an active game.'
                );
            }
            throw new Error('Room is already finished.');
        }

        const isParticipant = room.players.some(
            p => p.userId && p.userId.toString() === userId.toString()
        );
        if (!isParticipant) {
            throw new Error('You are not a participant in this room.');
        }

        await this._cancelAndRefundRoom(room, 'user_cancelled_search');
        logger.info(
            'ROOM',
            `Online search cancelled by ${userId} — room ${room.roomCode} refunded`
        );
        return room;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // _forfeitOnlineRoom  (internal — OM4)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Award forfeit win to the still-connected opponent in an online room.
     * Atomic guard prevents double-execution; distributeRoomReward uses its own
     * idempotencyKey so a cron retry cannot double-pay.
     *
     * @param {GameRoom} room
     * @param {ObjectId} winnerId
     * @param {string}   winnerUsername
     * @param {ObjectId} disconnectedUserId
     * @param {import('socket.io').Server|null} io
     */
    static async _forfeitOnlineRoom(room, winnerId, winnerUsername, disconnectedUserId, io = null) {
        const updated = await GameRoom.findOneAndUpdate(
            { _id: room._id, status: { $in: ['active', 'paused'] }, rewardDistributed: false },
            { $set: { status: 'completed', completedAt: new Date(), cancelReason: 'disconnect_forfeit', winnerId, winnerUsername }},
            { new: true }
        );

        if (!updated) {
            logger.warn('ROOM', `_forfeitOnlineRoom skipped for ${room.roomCode} — already resolved`);
            return;
        }

        const { prize, platformFee } = await this.distributeRoomReward(updated);

        if (io) {
            emitToMatch(io, room._id, 'game:match:end', {
                roomId: room._id,
                winnerId,
                winnerUsername,
                payout:             prize,
                platformFee,
                forfeit:            true,
                disconnectedUserId,
                finalState:         updated.state,
            });
        }

        logger.info('ROOM_CRON',
            `Online room ${room.roomCode} — forfeit win for ${winnerUsername} ($${prize})`);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // _cancelAndRefundRoom  (internal)
    // ──────────────────────────────────────────────────────────────────────────
    /**
     * Set room to 'cancelled', refund all non-bot players their entry fee.
     * Idempotent: uses idempotencyKey to prevent double-refund.
     *
     * @param {GameRoom} room  Mongoose document (not lean)
     * @param {string} reason  Cancel reason string
     * @returns {ObjectId[]}  Array of userId values that received refunds
     */
    static async _cancelAndRefundRoom(room, reason = 'admin_cancel') {
        const refunded = [];

        for (const player of room.players) {
            if (player.isBot || !player.userId) continue;
            if (room.entryFee <= 0) continue;

            const ikey = `room_refund_${room._id}_${player.userId}`;

            // Idempotency: skip if refund transaction already exists
            const alreadyRefunded = await Transaction.findOne({ idempotencyKey: ikey }).lean();
            if (alreadyRefunded) continue;

            try {
                await User.findByIdAndUpdate(player.userId, {
                    $inc: { 'wallet.balance': room.entryFee }
                });
                await Transaction.create({
                    userId: player.userId,
                    type: 'game_cancel_refund',
                    amount: room.entryFee,
                    status: 'completed',
                    description:
                        `${room.gameName} room cancelled ` +
                        `(Room ${room.roomCode}, reason: ${reason})`,
                    processedAt: new Date(),
                    idempotencyKey: ikey
                });
                refunded.push(player.userId);
                logger.info(
                    'ROOM',
                    `Refunded $${room.entryFee} to ${player.userId} — room ${room.roomCode} (${reason})`
                );
            } catch (err) {
                logger.error(
                    'ROOM',
                    `Refund failed for ${player.userId} in room ${room._id}: ${err.message}`
                );
            }
        }

        room.status     = 'cancelled';
        room.cancelledAt = new Date();
        room.cancelReason = reason;
        await room.save();

        return refunded;
    }
}

module.exports = RoomManager;
