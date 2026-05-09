/**
 * GameMatch — Records for completed and active matches
 */
const mongoose = require('mongoose');

const matchPlayerSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    username: { type: String, required: true },
    score: { type: Number, default: 0 },
    finishedAt: { type: Date, default: null },
    rank: { type: Number, default: 0 },
    hasPlayed: { type: Boolean, default: false }
}, { _id: false });

const gameMatchSchema = new mongoose.Schema({
    gameName: {
        type: String,
        enum: ['flappy-bird', 'fruit-ninja'],
        required: true,
        index: true
    },
    players: [matchPlayerSchema],
    status: {
        type: String,
        enum: ['pending', 'active', 'completed', 'cancelled'],
        default: 'pending',
        index: true
    },
    // ═══ FINANCIAL ═══
    entryFee: { type: Number, required: true },
    totalPool: { type: Number, default: 0 },
    winnerPrize: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 }, // totalPool - winnerPrize

    // ═══ WINNER ═══
    winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    winnerUsername: { type: String, default: '' },

    // ═══ SETTINGS SNAPSHOT ═══
    settings: {
        winnerPercentage: { type: Number, default: 40 },
        scoringMode: { type: String, default: 'score' },
        matchDurationSeconds: { type: Number, default: 120 },
        matchTimeoutMinutes: { type: Number, default: 60 }
    },

    // ═══ TIMING ═══
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    timeoutAt: { type: Date, required: true }, // auto-finalize deadline
}, { timestamps: true });

gameMatchSchema.index({ gameName: 1, status: 1, createdAt: -1 });
gameMatchSchema.index({ 'players.userId': 1, status: 1 });
gameMatchSchema.index({ timeoutAt: 1, status: 1 });

/**
 * Check if all players have submitted scores
 */
gameMatchSchema.methods.allPlayersFinished = function () {
    return this.players.every(p => p.hasPlayed);
};

/**
 * Determine winner based on scoring mode
 * For ties: earliest finishedAt wins
 */
gameMatchSchema.methods.determineWinner = function () {
    const playedPlayers = this.players.filter(p => p.hasPlayed);
    if (playedPlayers.length === 0) return null;

    playedPlayers.sort((a, b) => {
        // Higher score is better for both modes
        if (b.score !== a.score) return b.score - a.score;
        // Tiebreaker: earliest finish
        if (a.finishedAt && b.finishedAt) {
            return a.finishedAt.getTime() - b.finishedAt.getTime();
        }
        return 0;
    });

    // Assign ranks
    playedPlayers.forEach((p, i) => { p.rank = i + 1; });

    // Players who didn't play get last rank
    this.players.filter(p => !p.hasPlayed).forEach(p => {
        p.rank = this.players.length;
    });

    return playedPlayers[0]; // winner
};

/**
 * Calculate prize amount
 */
gameMatchSchema.methods.calculatePrize = function () {
    this.totalPool = this.entryFee * this.players.length;
    this.winnerPrize = parseFloat(((this.totalPool * this.settings.winnerPercentage) / 100).toFixed(2));
    this.platformFee = parseFloat((this.totalPool - this.winnerPrize).toFixed(2));
    return this.winnerPrize;
};

/**
 * Get active match for a user
 */
gameMatchSchema.statics.getActiveForUser = async function (userId) {
    return this.findOne({
        'players.userId': userId,
        status: { $in: ['pending', 'active'] }
    });
};

/**
 * Get match history for a user
 */
gameMatchSchema.statics.getUserHistory = async function (userId, limit = 20, skip = 0) {
    return this.find({ 'players.userId': userId, status: 'completed' })
        .sort({ completedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
};

module.exports = mongoose.model('GameMatch', gameMatchSchema);
