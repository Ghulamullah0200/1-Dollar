/**
 * PlayerStats — Aggregated player statistics per game
 */
const mongoose = require('mongoose');

const playerStatsSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    username: { type: String, required: true },
    gameName: {
        type: String,
        enum: ['flappy-bird', 'fruit-ninja'],
        required: true
    },
    // ═══ GAME STATS ═══
    totalGames: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    totalLosses: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 }, // percentage
    highScore: { type: Number, default: 0 },
    averageScore: { type: Number, default: 0 },
    totalScoreSum: { type: Number, default: 0 }, // for computing average

    // ═══ FINANCIAL STATS ═══
    totalEarnings: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    netProfit: { type: Number, default: 0 },

    // ═══ STREAKS ═══
    currentWinStreak: { type: Number, default: 0 },
    bestWinStreak: { type: Number, default: 0 },

    lastPlayedAt: { type: Date, default: null },
}, { timestamps: true });

// Compound index for leaderboard queries
playerStatsSchema.index({ gameName: 1, highScore: -1 });
playerStatsSchema.index({ gameName: 1, totalWins: -1 });
playerStatsSchema.index({ gameName: 1, totalEarnings: -1 });
playerStatsSchema.index({ userId: 1, gameName: 1 }, { unique: true });

/**
 * Get or create stats for a user+game combo
 */
playerStatsSchema.statics.getOrCreate = async function (userId, username, gameName) {
    let stats = await this.findOne({ userId, gameName });
    if (!stats) {
        stats = await this.create({ userId, username, gameName });
    }
    return stats;
};

/**
 * Record a game result
 */
playerStatsSchema.statics.recordResult = async function (userId, username, gameName, { score, won, earnings, entryFee }) {
    let stats = await this.getOrCreate(userId, username, gameName);

    stats.totalGames += 1;
    stats.totalScoreSum += score;
    stats.averageScore = parseFloat((stats.totalScoreSum / stats.totalGames).toFixed(2));
    stats.totalSpent += entryFee;
    stats.lastPlayedAt = new Date();

    if (score > stats.highScore) stats.highScore = score;

    if (won) {
        stats.totalWins += 1;
        stats.totalEarnings += earnings;
        stats.currentWinStreak += 1;
        if (stats.currentWinStreak > stats.bestWinStreak) {
            stats.bestWinStreak = stats.currentWinStreak;
        }
    } else {
        stats.totalLosses += 1;
        stats.currentWinStreak = 0;
    }

    stats.winRate = stats.totalGames > 0
        ? parseFloat(((stats.totalWins / stats.totalGames) * 100).toFixed(1))
        : 0;
    stats.netProfit = parseFloat((stats.totalEarnings - stats.totalSpent).toFixed(2));

    await stats.save();
    return stats;
};

/**
 * Get leaderboard
 */
playerStatsSchema.statics.getLeaderboard = async function (gameName, sortBy = 'highScore', limit = 50) {
    const sortField = {};
    sortField[sortBy] = -1;
    return this.find({ gameName, totalGames: { $gt: 0 } })
        .sort(sortField)
        .limit(limit)
        .select('userId username highScore totalWins totalGames winRate totalEarnings')
        .lean();
};

module.exports = mongoose.model('PlayerStats', playerStatsSchema);
