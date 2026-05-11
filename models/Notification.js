const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    type: {
        type: String,
        enum: ['system', 'referral', 'withdrawal', 'deposit', 'broadcast', 'manual', 'game_reward', 'match_result', 'security'],
        default: 'system',
        index: true
    },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    metadata: {
        transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
        amount: { type: Number, default: null },
    },
    sentViaFCM: { type: Boolean, default: false },
    fcmMessageId: { type: String, default: null },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

notificationSchema.index({ type: 1, createdAt: -1 });
notificationSchema.index({ targetUserId: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
