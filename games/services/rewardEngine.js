/**
 * Reward Engine — Prize calculation and wallet credit distribution
 */
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const logger = require('../../utils/logger');

class RewardEngine {
    /**
     * Distribute reward for a completed match
     * @param {Object} match - The completed match document
     * @param {ObjectId} [winnerId] - Specific winner ID (for multi-winner support)
     * @param {Number} [prizeAmount] - Specific prize amount (for split prizes)
     */
    static async distributeReward(match, winnerId = null, prizeAmount = null) {
        const targetWinnerId = winnerId || match.winnerId;
        const targetPrize = prizeAmount || match.winnerPrize;

        if (!targetWinnerId) return { success: false, reason: 'no_winner' };
        if (targetPrize <= 0) return { success: false, reason: 'no_prize' };

        // Idempotent: primary guard via matchId; secondary legacy fallback via description regex
        const rewardIkey = `reward_${match._id}_${targetWinnerId}`;
        const existingReward = await Transaction.findOne({
            $or: [
                { idempotencyKey: rewardIkey },
                { userId: targetWinnerId, type: 'game_reward', matchId: match._id }
            ]
        });
        if (existingReward) {
            logger.warn('REWARD', `Duplicate reward prevented for ${targetWinnerId} in match ${match._id}`);
            return { success: false, reason: 'duplicate_reward' };
        }

        try {
            // Atomic wallet credit
            const updatedUser = await User.findByIdAndUpdate(
                targetWinnerId,
                {
                    $inc: {
                        'wallet.balance': targetPrize,
                        'wallet.totalEarned': targetPrize
                    }
                },
                { new: true }
            );

            if (!updatedUser) {
                logger.error('REWARD', `Winner ${targetWinnerId} not found for match ${match._id}`);
                return { success: false, reason: 'user_not_found' };
            }

            // Create transaction record with matchId + idempotencyKey
            const transaction = await Transaction.create({
                userId: targetWinnerId,
                type: 'game_reward',
                amount: targetPrize,
                status: 'completed',
                description: `${match.gameName} match win — Pool: $${match.totalPool.toFixed(2)}, Prize: $${targetPrize.toFixed(2)} — Match ${match._id.toString().slice(-8)}`,
                matchId: match._id,
                processedAt: new Date(),
                idempotencyKey: rewardIkey
            });

            // Create fee deduction transactions for all players (only on first winner call)
            if (!winnerId || winnerId.toString() === match.winnerId?.toString()) {
                for (const player of match.players) {
                    const feeIkey = `entry_fee_${match._id}_${player.userId}`;
                    // Primary guard: idempotencyKey or matchId; secondary: description regex
                    const existingFee = await Transaction.findOne({
                        $or: [
                            { idempotencyKey: feeIkey },
                            { userId: player.userId, type: 'game_entry_fee', matchId: match._id }
                        ]
                    });
                    if (!existingFee) {
                        await Transaction.create({
                            userId: player.userId,
                            type: 'game_entry_fee',
                            amount: -match.entryFee,
                            status: 'completed',
                            description: `${match.gameName} entry fee — Match ${match._id.toString().slice(-8)}`,
                            matchId: match._id,
                            processedAt: new Date(),
                            idempotencyKey: feeIkey
                        });
                    }
                }
            }

            logger.info('REWARD', `$${targetPrize} credited to ${updatedUser.username} for match ${match._id}`);

            return {
                success: true,
                prize: targetPrize,
                winnerId: targetWinnerId,
                winnerBalance: updatedUser.wallet.balance,
                transactionId: transaction._id
            };
        } catch (err) {
            logger.error('REWARD', `Distribution failed for match ${match._id}: ${err.message}`);
            return { success: false, reason: err.message };
        }
    }

    /**
     * Get earnings history for a user
     */
    static async getEarningsHistory(userId, limit = 20) {
        return Transaction.find({
            userId,
            type: { $in: ['game_reward', 'game_entry_fee', 'game_subscription'] }
        })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
    }

    /**
     * Get total game revenue (platform fees)
     */
    static async getTotalRevenue() {
        const result = await require('../models/GameMatch').aggregate([
            { $match: { status: 'completed' } },
            {
                $group: {
                    _id: '$gameName',
                    totalPool: { $sum: '$totalPool' },
                    totalPrizes: { $sum: '$winnerPrize' },
                    totalFees: { $sum: '$platformFee' },
                    matchCount: { $sum: 1 }
                }
            }
        ]);
        return result;
    }
}

module.exports = RewardEngine;
