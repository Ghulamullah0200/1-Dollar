/**
 * Analytics Engine — Game analytics queries for admin dashboard
 */
const GameMatch = require('../models/GameMatch');
const GameQueue = require('../models/GameQueue');
const GameSession = require('../models/GameSession');
const GameSubscription = require('../models/GameSubscription');
const PlayerStats = require('../models/PlayerStats');

class AnalyticsEngine {
    /**
     * Get dashboard overview
     */
    static async getDashboardStats() {
        const [
            totalMatches,
            activeMatches,
            completedMatches,
            totalSubscriptions,
            activeSubscriptions,
            revenueData,
            queueStats
        ] = await Promise.all([
            GameMatch.countDocuments(),
            GameMatch.countDocuments({ status: 'active' }),
            GameMatch.countDocuments({ status: 'completed' }),
            GameSubscription.countDocuments(),
            GameSubscription.countDocuments({ isActive: true, expiresAt: { $gt: new Date() } }),
            this.getRevenueStats(),
            this.getQueueStats()
        ]);

        return {
            totalMatches,
            activeMatches,
            completedMatches,
            totalSubscriptions,
            activeSubscriptions,
            revenue: revenueData,
            queues: queueStats
        };
    }

    /**
     * Revenue breakdown per game
     */
    static async getRevenueStats() {
        const matchRevenue = await GameMatch.aggregate([
            { $match: { status: 'completed' } },
            {
                $group: {
                    _id: '$gameName',
                    totalPool: { $sum: '$totalPool' },
                    totalPrizes: { $sum: '$winnerPrize' },
                    platformRevenue: { $sum: '$platformFee' },
                    matchCount: { $sum: 1 }
                }
            }
        ]);

        const subRevenue = await GameSubscription.aggregate([
            {
                $group: {
                    _id: '$gameName',
                    totalSubRevenue: { $sum: '$amount' },
                    subCount: { $sum: 1 }
                }
            }
        ]);

        return { matchRevenue, subscriptionRevenue: subRevenue };
    }

    /**
     * Queue statistics
     */
    static async getQueueStats() {
        const stats = await GameQueue.aggregate([
            { $match: { status: 'waiting' } },
            {
                $group: {
                    _id: '$gameName',
                    count: { $sum: 1 },
                    oldest: { $min: '$joinedAt' }
                }
            }
        ]);
        return stats;
    }

    /**
     * Daily match count for charts (last 30 days)
     */
    static async getDailyMatchCounts(days = 30) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        return GameMatch.aggregate([
            { $match: { createdAt: { $gte: startDate }, status: 'completed' } },
            {
                $group: {
                    _id: {
                        date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        game: '$gameName'
                    },
                    count: { $sum: 1 },
                    revenue: { $sum: '$platformFee' }
                }
            },
            { $sort: { '_id.date': 1 } }
        ]);
    }

    /**
     * Top players
     */
    static async getTopPlayers(gameName, limit = 10) {
        return PlayerStats.find({ gameName, totalGames: { $gt: 0 } })
            .sort({ totalEarnings: -1 })
            .limit(limit)
            .select('userId username totalWins totalGames winRate totalEarnings highScore')
            .lean();
    }

    /**
     * Active player count (played in last 24h)
     */
    static async getActivePlayerCount() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        return GameSession.distinct('userId', { createdAt: { $gte: oneDayAgo } }).then(ids => ids.length);
    }

    /**
     * Get all matches with filters for admin
     */
    static async getMatchesForAdmin({ gameName, status, page = 1, limit = 20 } = {}) {
        const filter = {};
        if (gameName) filter.gameName = gameName;
        if (status) filter.status = status;

        const [matches, total] = await Promise.all([
            GameMatch.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            GameMatch.countDocuments(filter)
        ]);

        return { matches, total, page, totalPages: Math.ceil(total / limit) };
    }
}

module.exports = AnalyticsEngine;
