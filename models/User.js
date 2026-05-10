const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    // ═══ REFERRAL SYSTEM ═══
    referralCode: { type: String, unique: true, sparse: true, index: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    referralCount: { type: Number, default: 0, index: true }, // Direct children
    grandReferralCount: { type: Number, default: 0 }, // Grandchildren
    // ═══ WALLET ═══
    wallet: {
        balance: { type: Number, default: 0 },
        totalEarned: { type: Number, default: 0 },
        signupBonus: { type: Number, default: 0 },
        referralEarnings: { type: Number, default: 0 },
    },
    // ═══ PAYMENT DETAILS ═══
    accountDetails: {
        accountTitle: { type: String, default: '' },
        accountNumber: { type: String, default: '' },
        bankName: { type: String, default: '' }
    },
    // ═══ STATUS ═══
    status: {
        type: String,
        enum: ['active', 'suspended', 'banned', 'admin'],
        default: 'active',
        index: true
    },
    // ═══ ANTI-FRAUD ═══
    ipAddress: { type: String, default: '' },
    deviceFingerprint: { type: String, default: '' },
    flaggedForFraud: { type: Boolean, default: false, index: true },
    fraudReason: { type: String, default: '' },
    // ═══ DEPOSIT VERIFICATION ═══
    depositStatus: {
        type: String,
        enum: ['none', 'pending', 'verified', 'rejected'],
        default: 'none',
        index: true
    },
    depositAmount: { type: Number, default: 0 },
    depositProof: { type: String, default: '' }, // base64 or URL of payment screenshot
    depositSubmittedAt: { type: Date, default: null },
    depositVerifiedAt: { type: Date, default: null },
    depositVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    depositRejectionReason: { type: String, default: '' },
    pendingDepositType: { type: String, enum: ['platform_fees', 'wallet_topup', ''], default: '' },
    pendingDepositPackageName: { type: String, default: '' },
    // ═══ PUSH NOTIFICATIONS (FCM) ═══
    fcmToken: { type: String, default: null, index: true },
    lastActiveAt: { type: Date, default: null },
}, { timestamps: true });

// Hash password before save
userSchema.pre('save', async function () {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 12);
    }
});

userSchema.methods.comparePassword = function (password) {
    return bcrypt.compare(password, this.password);
};

// Generate referral code in pattern: 1dollar.username.random
userSchema.methods.generateReferralCode = function () {
    const random = Math.floor(1000 + Math.random() * 9000);
    return `1dollar.${this.username.toLowerCase()}.${random}`;
};

module.exports = mongoose.model('User', userSchema);
