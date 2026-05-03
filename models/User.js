const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    // ═══ REFERRAL SYSTEM ═══
    referralCode: { type: String, unique: true, sparse: true, index: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    referralCount: { type: Number, default: 0, index: true },
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

// Generate referral code from user ID
userSchema.methods.generateReferralCode = function () {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(this._id.toString()).digest('hex').substring(0, 8).toUpperCase();
};

module.exports = mongoose.model('User', userSchema);
