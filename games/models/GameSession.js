/**
 * GameSession — Individual game play sessions within a match
 */
const mongoose = require('mongoose');

const gameSessionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'GameMatch', required: true, index: true },
    gameName: {
        type: String,
        enum: ['flappy-bird', 'fruit-ninja'],
        required: true
    },
    score: { type: Number, default: 0 },
    duration: { type: Number, default: 0 }, // in milliseconds
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    deviceInfo: {
        platform: { type: String, default: '' },
        model: { type: String, default: '' },
        screenWidth: { type: Number, default: 0 },
        screenHeight: { type: Number, default: 0 }
    },
    // ═══ ANTI-CHEAT ═══
    scoreHash: { type: String, default: '' }, // signed score for verification
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, default: '' },
}, { timestamps: true });

gameSessionSchema.index({ userId: 1, gameName: 1, createdAt: -1 });
gameSessionSchema.index({ matchId: 1, userId: 1 });

module.exports = mongoose.model('GameSession', gameSessionSchema);
