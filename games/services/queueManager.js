/**
 * Queue Manager — Handles queue join/leave and matchmaking
 */
const GameQueue = require('../models/GameQueue');
const GameMatch = require('../models/GameMatch');
const GameSettings = require('../models/GameSettings');
const GameSubscription = require('../models/GameSubscription');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const crypto = require('crypto');
const logger = require('../../utils/logger');

class QueueManager {
    /**
     * Add user to game queue
     */
    static async joinQueue(userId, gameName, deviceInfo = {}) {
        // 1. Validate game settings
        const settings = await GameSettings.getForGame(gameName);
        if (!settings.isActive) {
            throw new Error('This game is currently disabled');
        }

        // 2. Validate user
        const user = await User.findById(userId).lean();
        if (!user) throw new Error('User not found');
        if (user.status === 'suspended' || user.status === 'banned') {
            throw new Error('Account is not eligible to play');
        }
        if (!user.hasPaidVerificationFee) {
            throw new Error('Account must be verified to play games');
        }

        // 3. Check subscription
        const hasSub = await GameSubscription.hasActive(userId, gameName);
        if (!hasSub) {
            throw new Error('Active subscription required. Please subscribe first.');
        }

        // 4. Check wallet balance
        if (user.wallet.balance < settings.entryFee) {
            throw new Error(`Insufficient balance. Entry fee is $${settings.entryFee.toFixed(2)}`);
        }

        // 5. Prevent duplicate queue entries
        const alreadyInQueue = await GameQueue.isUserInQueue(userId, gameName);
        if (alreadyInQueue) {
            throw new Error('You are already in the queue for this game');
        }

        // 6. Check active match
        const activeMatch = await GameMatch.getActiveForUser(userId);
        if (activeMatch) {
            throw new Error('You already have an active match. Complete it first.');
        }

        // 7. Check cooldown
        const lastEntry = await GameQueue.findOne({
            userId, gameName, status: { $in: ['completed', 'cancelled'] }
        }).sort({ updatedAt: -1 });
        if (lastEntry) {
            const cooldownMs = settings.cooldownSeconds * 1000;
            const elapsed = Date.now() - lastEntry.updatedAt.getTime();
            if (elapsed < cooldownMs) {
                const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
                throw new Error(`Cooldown active. Please wait ${remaining} seconds.`);
            }
        }

        // 8. Check queue capacity
        const queueCount = await GameQueue.getQueueCount(gameName);
        if (queueCount >= settings.maxQueueSize) {
            throw new Error('Queue is full. Please try again later.');
        }

        // 9. Add to queue
        const queueEntry = await GameQueue.create({
            userId,
            username: user.username,
            gameName,
            entryFee: settings.entryFee,
            deviceInfo,
            status: 'waiting'
        });

        logger.info('QUEUE', `${user.username} joined ${gameName} queue`);

        // 10. Auto-process queue
        const matchResult = await this.processQueue(gameName);

        return {
            queueEntry,
            matchCreated: matchResult ? true : false,
            match: matchResult,
            queuePosition: await GameQueue.getQueueCount(gameName)
        };
    }

    /**
     * Remove user from queue
     */
    static async leaveQueue(userId, gameName) {
        const entry = await GameQueue.findOneAndUpdate(
            { userId, gameName, status: 'waiting' },
            { status: 'cancelled' },
            { new: true }
        );
        if (!entry) throw new Error('You are not in the queue');
        logger.info('QUEUE', `${entry.username} left ${gameName} queue`);
        return entry;
    }

    /**
     * Process queue — create matches in batches of playersPerMatch
     */
    static async processQueue(gameName) {
        const settings = await GameSettings.getForGame(gameName);
        const waitingPlayers = await GameQueue.getWaitingPlayers(gameName);

        if (waitingPlayers.length < settings.playersPerMatch) {
            return null; // Not enough players
        }

        const matches = [];
        const batchCount = Math.floor(waitingPlayers.length / settings.playersPerMatch);

        for (let i = 0; i < batchCount; i++) {
            const batch = waitingPlayers.slice(
                i * settings.playersPerMatch,
                (i + 1) * settings.playersPerMatch
            );

            try {
                const match = await this._createMatchFromBatch(batch, settings);
                if (match) matches.push(match);
            } catch (err) {
                logger.error('QUEUE', `Failed to create match: ${err.message}`);
            }
        }

        return matches.length > 0 ? matches : null;
    }

    /**
     * Internal: Create a match from a batch of players.
     * Entry fees are deducted BEFORE the match is created.
     * If any player cannot be charged, all already-charged players are refunded
     * and the match is NOT created. Returns null on abort.
     */
    static async _createMatchFromBatch(players, settings) {
        // Unique ID for this formation attempt — used to make refund idempotencyKeys deterministic
        const batchAttemptId = crypto.randomBytes(8).toString('hex');

        // STEP 1: Attempt entry fee deduction for every player atomically
        const chargedPlayers = [];
        const failedPlayers = [];

        for (const player of players) {
            const deducted = await User.findOneAndUpdate(
                { _id: player.userId, 'wallet.balance': { $gte: settings.entryFee } },
                { $inc: { 'wallet.balance': -settings.entryFee } }
            );
            if (deducted) {
                chargedPlayers.push(player);
            } else {
                failedPlayers.push(player);
                logger.warn('MATCH', `Player ${player.username} (${player.userId}) has insufficient balance — cannot charge entry fee`);
            }
        }

        // STEP 2: If any player could not be charged, abort and refund
        if (failedPlayers.length > 0) {
            // Refund every player that was already charged
            for (const player of chargedPlayers) {
                await User.findByIdAndUpdate(
                    player.userId,
                    { $inc: { 'wallet.balance': settings.entryFee } }
                );
                try {
                    await Transaction.create({
                        userId: player.userId,
                        type: 'game_cancel_refund',
                        amount: settings.entryFee,
                        status: 'completed',
                        description: `${settings.gameName} entry fee refund — match not formed (insufficient balance in batch)`,
                        processedAt: new Date(),
                        idempotencyKey: `queue_refund_${batchAttemptId}_${player.userId}`
                    });
                } catch (txErr) {
                    if (txErr.code !== 11000) {
                        logger.error('MATCH', `Failed to record cancel-refund transaction for ${player.username}: ${txErr.message}`);
                    }
                }
                // Reset this player back to waiting so they can be re-matched
                await GameQueue.findByIdAndUpdate(player._id, { status: 'waiting' });
                logger.info('MATCH', `Player ${player.username} refunded $${settings.entryFee} and returned to waiting queue`);
            }

            // Remove insufficient-balance players from queue
            for (const player of failedPlayers) {
                await GameQueue.findByIdAndUpdate(player._id, { status: 'cancelled' });
                logger.warn('QUEUE', `Player ${player.username} (${player.userId}) removed from queue — insufficient balance at match formation`);
            }

            logger.error('MATCH', `Match formation aborted for ${settings.gameName} — ${failedPlayers.length} player(s) had insufficient funds. ${chargedPlayers.length} player(s) refunded and returned to queue.`);
            return null;
        }

        // STEP 3: All players charged — create the match
        const timeoutAt = new Date(Date.now() + settings.matchTimeoutMinutes * 60 * 1000);

        const match = await GameMatch.create({
            gameName: settings.gameName,
            players: players.map(p => ({
                userId: p.userId,
                username: p.username,
                score: 0,
                hasPlayed: false
            })),
            status: 'active',
            entryFee: settings.entryFee,
            totalPool: settings.entryFee * players.length,
            settings: {
                winnerPercentage: settings.winnerPercentage,
                scoringMode: settings.scoringMode,
                matchDurationSeconds: settings.matchDurationSeconds,
                matchTimeoutMinutes: settings.matchTimeoutMinutes
            },
            timeoutAt
        });

        // Calculate prize
        match.calculatePrize();
        await match.save();

        // STEP 4: Mark all queue entries as matched
        for (const player of players) {
            await GameQueue.findByIdAndUpdate(player._id, {
                status: 'matched',
                matchId: match._id
            });
        }

        logger.info('MATCH', `Match ${match._id} created for ${settings.gameName} with ${players.length} players. Pool: $${match.totalPool}`);

        return match;
    }

    /**
     * Get queue status for a game
     */
    static async getQueueStatus(gameName) {
        const settings = await GameSettings.getForGame(gameName);
        const count = await GameQueue.getQueueCount(gameName);
        return {
            gameName,
            queueCount: count,
            playersNeeded: settings.playersPerMatch,
            playersRemaining: Math.max(0, settings.playersPerMatch - (count % settings.playersPerMatch)),
            isActive: settings.isActive,
            entryFee: settings.entryFee
        };
    }

    /**
     * Get user's position in queue
     */
    static async getUserQueuePosition(userId, gameName) {
        const waiting = await GameQueue.find({ gameName, status: 'waiting' }).sort({ joinedAt: 1 }).lean();
        const index = waiting.findIndex(q => q.userId.toString() === userId.toString());
        return index === -1 ? null : index + 1;
    }
}

module.exports = QueueManager;
