'use strict';

/**
 * GameMove — Immutable per-move audit log for Carrom and Ludo.
 *
 * Every move validated by the server (shots, dice rolls, token moves,
 * forfeits, and room events) is recorded here with full state snapshots.
 *
 * Used for:
 *   - Anti-cheat review (flagged field)
 *   - Game replay
 *   - Dispute resolution
 *
 * TTL: documents auto-expire after 30 days (configurable via the index below).
 */
const mongoose = require('mongoose');

const gameMoveSchema = new mongoose.Schema({
    roomId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'GameRoom',
        required: true,
        index: true
    },
    gameName: {
        type: String,
        enum: ['carrom', 'ludo'],
        required: true
    },

    // null for bot moves — bots have no userId
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },

    // Sequential within the room (1, 2, 3 …)
    moveNumber: {
        type: Number,
        required: true,
        min: 1
    },

    // Carrom:  'shot' | 'foul' | 'timeout'
    // Ludo:    'dice_roll' | 'token_move' | 'timeout'
    // Shared:  'forfeit' | 'room_start' | 'room_end'
    moveType: {
        type: String,
        required: true
    },

    // Full move parameters.
    // Carrom shot example: { angle: 45.2, power: 78, strikerX: 256 }
    // Ludo dice example:   { diceValue: 4 }
    // Ludo token example:  { tokenId: 'red_1', diceValue: 4, fromPosition: 12, toPosition: 16 }
    moveData: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },

    // Full GameRoom.state snapshot BEFORE this move was applied.
    // Populated by game engines (carromEngine / ludoEngine) in Phase 2+.
    // Phase 1: null.
    stateBeforeMove: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },

    // Full GameRoom.state snapshot AFTER this move was applied.
    // Phase 1: null.
    stateAfterMove: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },

    // Server-side processing time in milliseconds.
    // Used to detect impossibly fast moves.
    processingMs: {
        type: Number,
        default: 0
    },

    // ═══ ANTI-CHEAT ═══
    flagged:    { type: Boolean, default: false },
    flagReason: { type: String, default: '' }
    // Examples: 'impossible_velocity' | 'too_fast' | 'invalid_token' | 'stale_state_version'

}, {
    timestamps: true   // createdAt used by the TTL index below
});

// ─── Indexes ───────────────────────────────────────────────────────────────────
gameMoveSchema.index({ roomId: 1, moveNumber: 1 });
gameMoveSchema.index({ userId: 1, createdAt: -1 });
gameMoveSchema.index({ flagged: 1, createdAt: -1 });

// TTL: auto-remove move records after 30 days (2 592 000 seconds)
gameMoveSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

module.exports = mongoose.model('GameMove', gameMoveSchema);
