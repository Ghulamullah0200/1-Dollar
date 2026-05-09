/**
 * GameQueue — Queue entries for matchmaking
 */
const mongoose = require('mongoose');

const gameQueueSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    username: { type: String, required: true },
    gameName: {
        type: String,
        enum: ['flappy-bird', 'fruit-ninja'],
        required: true
    },
    entryFee: { type: Number, required: true },
    status: {
        type: String,
        enum: ['waiting', 'matched', 'playing', 'completed', 'cancelled'],
        default: 'waiting',
        index: true
    },
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'GameMatch', default: null },
    deviceInfo: {
        platform: { type: String, default: '' },
        model: { type: String, default: '' },
        screenWidth: { type: Number, default: 0 },
        screenHeight: { type: Number, default: 0 }
    },
    joinedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Compound indexes for efficient queue processing
gameQueueSchema.index({ gameName: 1, status: 1, joinedAt: 1 });
gameQueueSchema.index({ userId: 1, gameName: 1, status: 1 });

// TTL: auto-remove entries older than 2 hours
gameQueueSchema.index({ joinedAt: 1 }, { expireAfterSeconds: 7200 });

/**
 * Check if user is already in queue for a game
 */
gameQueueSchema.statics.isUserInQueue = async function (userId, gameName) {
    const count = await this.countDocuments({
        userId,
        gameName,
        status: { $in: ['waiting', 'matched', 'playing'] }
    });
    return count > 0;
};

/**
 * Get waiting players for a game
 */
gameQueueSchema.statics.getWaitingPlayers = async function (gameName) {
    return this.find({ gameName, status: 'waiting' })
        .sort({ joinedAt: 1 })
        .lean();
};

/**
 * Get queue count for a game
 */
gameQueueSchema.statics.getQueueCount = async function (gameName) {
    return this.countDocuments({ gameName, status: 'waiting' });
};

module.exports = mongoose.model('GameQueue', gameQueueSchema);
