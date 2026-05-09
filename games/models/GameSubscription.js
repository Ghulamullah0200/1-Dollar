/**
 * GameSubscription — Tracks player game subscriptions with 30-day expiry
 */
const mongoose = require('mongoose');

const gameSubscriptionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    gameName: {
        type: String,
        enum: ['flappy-bird', 'fruit-ninja'],
        required: true
    },
    // ═══ SUBSCRIPTION STATE ═══
    isActive: { type: Boolean, default: true, index: true },
    purchasedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    // ═══ PAYMENT ═══
    amount: { type: Number, required: true },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
}, { timestamps: true });

// Compound index for fast lookups
gameSubscriptionSchema.index({ userId: 1, gameName: 1 });
gameSubscriptionSchema.index({ expiresAt: 1, isActive: 1 });

/**
 * Check if subscription is currently valid
 */
gameSubscriptionSchema.methods.isValid = function () {
    return this.isActive && new Date() < this.expiresAt;
};

/**
 * Get active subscription for a user+game combo
 */
gameSubscriptionSchema.statics.getActive = async function (userId, gameName) {
    const sub = await this.findOne({
        userId,
        gameName,
        isActive: true,
        expiresAt: { $gt: new Date() }
    }).sort({ expiresAt: -1 });
    return sub;
};

/**
 * Check if user has active subscription
 */
gameSubscriptionSchema.statics.hasActive = async function (userId, gameName) {
    const count = await this.countDocuments({
        userId,
        gameName,
        isActive: true,
        expiresAt: { $gt: new Date() }
    });
    return count > 0;
};

/**
 * Deactivate expired subscriptions (run periodically)
 */
gameSubscriptionSchema.statics.deactivateExpired = async function () {
    const result = await this.updateMany(
        { isActive: true, expiresAt: { $lte: new Date() } },
        { $set: { isActive: false } }
    );
    return result.modifiedCount;
};

module.exports = mongoose.model('GameSubscription', gameSubscriptionSchema);
