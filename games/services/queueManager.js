/**
 * Queue Manager — Handles queue join/leave and matchmaking
 */
const GameQueue = require('../models/GameQueue');
const GameMatch = require('../models/GameMatch');
const GameSettings = require('../models/GameSettings');
const GameSubscription = require('../models/GameSubscription');
const User = require('../../models/User');
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
        if (user.depositStatus !== 'verified') {
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
                matches.push(match);
            } catch (err) {
                logger.error('QUEUE', `Failed to create match: ${err.message}`);
            }
        }

        return matches.length > 0 ? matches : null;
    }

    /**
     * Internal: Create a match from a batch of players
     */
    static async _createMatchFromBatch(players, settings) {
        const timeoutAt = new Date(Date.now() + settings.matchTimeoutMinutes * 60 * 1000);

        // Create the match
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

        // Deduct entry fees from all players' wallets atomically
        for (const player of players) {
            await User.findByIdAndUpdate(player.userId, {
                $inc: {
                    'wallet.balance': -settings.entryFee
                }
            });

            // Update queue entry
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
