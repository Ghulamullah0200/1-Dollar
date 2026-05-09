/**
 * Reward Engine — Prize calculation and wallet credit distribution
 */
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const logger = require('../../utils/logger');

class RewardEngine {
    /**
     * Distribute reward for a completed match
     */
    static async distributeReward(match) {
        if (!match.winnerId) return { success: false, reason: 'no_winner' };
        if (match.winnerPrize <= 0) return { success: false, reason: 'no_prize' };

        try {
            // Atomic wallet credit
            const updatedUser = await User.findByIdAndUpdate(
                match.winnerId,
                {
                    $inc: {
                        'wallet.balance': match.winnerPrize,
                        'wallet.totalEarned': match.winnerPrize
                    }
                },
                { new: true }
            );

            if (!updatedUser) {
                logger.error('REWARD', `Winner ${match.winnerId} not found for match ${match._id}`);
                return { success: false, reason: 'user_not_found' };
            }

            // Create transaction record
            const transaction = await Transaction.create({
                userId: match.winnerId,
                type: 'game_reward',
                amount: match.winnerPrize,
                status: 'completed',
                description: `${match.gameName} match win — Pool: $${match.totalPool.toFixed(2)}, Prize: $${match.winnerPrize.toFixed(2)}`,
                processedAt: new Date()
            });

            // Create fee deduction transactions for all players
            for (const player of match.players) {
                await Transaction.create({
                    userId: player.userId,
                    type: 'game_entry_fee',
                    amount: -match.entryFee,
                    status: 'completed',
                    description: `${match.gameName} entry fee — Match ${match._id.toString().slice(-8)}`,
                    processedAt: new Date()
                });
            }

            logger.info('REWARD', `$${match.winnerPrize} credited to ${updatedUser.username} for match ${match._id}`);

            return {
                success: true,
                prize: match.winnerPrize,
                winnerId: match.winnerId,
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
