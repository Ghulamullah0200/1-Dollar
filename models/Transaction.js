const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
        type: String,
        enum: [
            'signup_bonus', 'referral_bonus', 'withdrawal', 'deposit',
            'verification', 'wallet_topup', 'game_entry_fee', 'game_reward',
            'game_subscription', 'admin_credit', 'admin_debit', 'admin_reset',
            'game_cancel_refund'
        ],
        required: true,
        index: true
    },
    amount: { type: Number, required: true },
    status: {
        type: String,
        enum: ['pending', 'completed', 'rejected'],
        default: 'pending',
        index: true
    },
    accountDetails: {
        accountTitle: { type: String, default: '' },
        accountNumber: { type: String, default: '' },
        bankName: { type: String, default: '' }
    },
    // For referral_bonus type — who was referred
    referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Deposit metadata
    depositType: { type: String, enum: ['platform_fees', 'wallet_topup', ''], default: '' },
    packageName: { type: String, default: '' },
    description: { type: String, default: '' },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
    // Idempotency — unique sparse so existing documents are unaffected
    idempotencyKey: { type: String, default: null },
    // Game match reference
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'GameMatch', default: null, index: true },
}, { timestamps: true });

transactionSchema.index({ userId: 1, type: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1, createdAt: -1 });
transactionSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Transaction', transactionSchema);
