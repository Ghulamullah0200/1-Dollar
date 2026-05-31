'use strict';

/**
 * GameRoom — Turn-based game session for Carrom and Ludo.
 *
 * This model is ONLY for Carrom and Ludo.
 * Flappy Bird and Fruit Ninja use GameMatch (score-based async model).
 *
 * Room lifecycle:
 *   waiting   — created, waiting for 2nd player (online mode only)
 *   active    — both players present, game in progress
 *   paused    — one player disconnected, within reconnect window
 *   completed — game finished normally, winner determined
 *   cancelled — cancelled before completion (admin, forfeit, timeout, creation failure)
 *   abandoned — all players disconnected past reconnect window
 */
const mongoose = require('mongoose');

// ─── Player subdocument ────────────────────────────────────────────────────────
const roomPlayerSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null       // null for bot players
    },
    username:       { type: String, required: true },
    color:          { type: String, default: '' },      // 'red' | 'blue' | 'white' | 'black'
    isBot:          { type: Boolean, default: false },
    difficulty:     {
        type: String,
        enum: ['easy', 'medium', 'hard'],
        default: 'medium'
    },
    isConnected:    { type: Boolean, default: false },
    connectedAt:    { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },
    score:          { type: Number, default: 0 },
    hasFinished:    { type: Boolean, default: false },
    rank:           { type: Number, default: 0 }
}, { _id: false });

// ─── Settings snapshot subdocument ────────────────────────────────────────────
// Taken from GameSettings at room creation so changes don't affect in-flight rooms.
const roomSettingsSnapshotSchema = new mongoose.Schema({
    winnerPercentage:        { type: Number, default: 70 },
    turnTimeoutSeconds:      { type: Number, default: 30 },
    reconnectTimeoutSeconds: { type: Number, default: 60 },
    matchTimeoutMinutes:     { type: Number, default: 30 }
}, { _id: false });

// ─── Main schema ───────────────────────────────────────────────────────────────
const gameRoomSchema = new mongoose.Schema({
    gameName: {
        type: String,
        enum: ['carrom', 'ludo'],  // NOT flappy-bird / fruit-ninja — those use GameMatch
        required: true,
        index: true
    },

    // 6-character uppercase code for private room sharing
    roomCode: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
        minlength: 6,
        maxlength: 6
    },

    status: {
        type: String,
        enum: ['waiting', 'active', 'paused', 'completed', 'cancelled', 'abandoned'],
        default: 'waiting',
        index: true
    },
    mode: {
        type: String,
        enum: ['bot', 'online'],
        required: true
    },

    // ═══ FINANCIAL ═══
    entryFee:   { type: Number, default: 0, min: 0 },
    totalPool:  { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    winnerPrize: { type: Number, default: 0 },
    winnerPct:   { type: Number, default: 70 },  // snapshot from GameSettings.winnerPercentage

    // ═══ PLAYERS ═══
    players: [roomPlayerSchema],

    // ═══ TURN TRACKING ═══
    // currentTurnUserId: null until game engine (carromEngine / ludoEngine) assigns first turn.
    currentTurnUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    turnStartedAt:    { type: Date, default: null },
    turnTimeoutSeconds: { type: Number, default: 30 },  // snapshot from GameSettings

    // ═══ GAME STATE ═══
    // Populated by carromEngine.js or ludoEngine.js in Phase 2+.
    // Phase 1: always null — no gameplay implemented yet.
    state:        { type: mongoose.Schema.Types.Mixed, default: null },
    stateVersion: { type: Number, default: 0 },  // incremented on every applied move

    // ═══ RESULT ═══
    winnerId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    winnerUsername: { type: String, default: '' },
    completedAt:    { type: Date, default: null },
    cancelledAt:    { type: Date, default: null },
    cancelReason:   { type: String, default: '' },
    // Reasons: 'admin_cancel' | 'timeout' | 'forfeit' | 'disconnect' | 'creation_failed'

    // ═══ WAITING ROOM AUTO-CANCEL ═══
    // Online waiting rooms are auto-cancelled after this time if no 2nd player joins.
    // A cron job or scheduled task checks this field. Phase 1: stored but not enforced yet.
    waitingTimeoutAt: { type: Date, default: null },

    // ═══ SETTINGS SNAPSHOT ═══
    settings: { type: roomSettingsSnapshotSchema, default: () => ({}) },

    // ═══ PAYOUT IDEMPOTENCY GUARD ═══
    // Set to true after RewardEngine.distributeReward completes.
    // Prevents double payout on retry.
    rewardDistributed: { type: Boolean, default: false }

}, { timestamps: true });

// ─── Indexes ───────────────────────────────────────────────────────────────────
gameRoomSchema.index({ status: 1, createdAt: -1 });
gameRoomSchema.index({ 'players.userId': 1, status: 1 });
gameRoomSchema.index({ gameName: 1, status: 1 });
// roomCode has unique:true from the field definition above

// ─── Static methods ────────────────────────────────────────────────────────────

/**
 * Get a user's active room (waiting, active, or paused).
 * Used to prevent joining/creating a 2nd room while one is in progress.
 */
gameRoomSchema.statics.getActiveForUser = async function (userId) {
    return this.findOne({
        'players.userId': userId,
        status: { $in: ['waiting', 'active', 'paused'] }
    });
};

/**
 * Get a waiting online room by its room code.
 * Used in joinRoom flow.
 */
gameRoomSchema.statics.getWaitingByCode = async function (roomCode) {
    return this.findOne({
        roomCode: roomCode.toString().toUpperCase().trim(),
        status: 'waiting'
    });
};

module.exports = mongoose.model('GameRoom', gameRoomSchema);
