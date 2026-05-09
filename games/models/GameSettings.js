/**
 * GameSettings — Admin-configurable game settings (singleton per game)
 * Controls entry fees, rewards, match size, subscriptions, etc.
 */
const mongoose = require('mongoose');

const gameSettingsSchema = new mongoose.Schema({
    gameName: {
        type: String,
        enum: ['flappy-bird', 'fruit-ninja'],
        required: true,
        unique: true,
        index: true
    },
    displayName: { type: String, required: true },
    description: { type: String, default: '' },

    // ═══ GAME STATE ═══
    isActive: { type: Boolean, default: true },

    // ═══ MATCH CONFIG ═══
    entryFee: { type: Number, default: 0.50, min: 0 },
    playersPerMatch: { type: Number, default: 5, min: 2 },
    winnersPerMatch: { type: Number, default: 1, min: 1 },
    winnerPercentage: { type: Number, default: 40, min: 1, max: 100 },
    matchDurationSeconds: { type: Number, default: 120 }, // max time per player
    matchTimeoutMinutes: { type: Number, default: 60 }, // auto-finalize after this

    // ═══ QUEUE CONFIG ═══
    maxQueueSize: { type: Number, default: 100 },
    cooldownSeconds: { type: Number, default: 30 }, // cooldown between plays

    // ═══ SUBSCRIPTION CONFIG ═══
    subscriptionPrice: { type: Number, default: 1.00, min: 0 },
    subscriptionDurationDays: { type: Number, default: 30, min: 1 },

    // ═══ SCORING ═══
    // 'survival' for Flappy Bird (longer = better)
    // 'score' for Fruit Ninja (higher = better)
    scoringMode: {
        type: String,
        enum: ['survival', 'score'],
        default: 'score'
    },
    maxScoreCap: { type: Number, default: 999999 }, // anti-cheat cap

    // ═══ META ═══
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

/**
 * Get or create settings for a specific game
 */
gameSettingsSchema.statics.getForGame = async function (gameName) {
    let settings = await this.findOne({ gameName });
    if (!settings) {
        const defaults = {
            'flappy-bird': {
                gameName: 'flappy-bird',
                displayName: 'Flappy Bird',
                description: 'Tap to fly! Survive as long as possible.',
                scoringMode: 'survival',
                entryFee: 0.50,
                subscriptionPrice: 1.00,
            },
            'fruit-ninja': {
                gameName: 'fruit-ninja',
                displayName: 'Fruit Ninja',
                description: 'Slice the fruits! Get the highest score.',
                scoringMode: 'score',
                entryFee: 0.50,
                subscriptionPrice: 1.00,
            }
        };
        settings = await this.create(defaults[gameName] || { gameName, displayName: gameName });
    }
    return settings;
};

/**
 * Update settings for a specific game
 */
gameSettingsSchema.statics.updateForGame = async function (gameName, updates, adminId) {
    let settings = await this.findOne({ gameName });
    if (!settings) {
        settings = await this.getForGame(gameName);
    }
    // Prevent changing gameName
    delete updates.gameName;
    Object.assign(settings, updates, { updatedBy: adminId });
    await settings.save();
    return settings;
};

/**
 * Get all game settings
 */
gameSettingsSchema.statics.getAllSettings = async function () {
    // Ensure both games exist
    await this.getForGame('flappy-bird');
    await this.getForGame('fruit-ninja');
    return this.find({}).lean();
};

module.exports = mongoose.model('GameSettings', gameSettingsSchema);
