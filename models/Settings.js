const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    // ═══ DEPOSIT SETTINGS ═══
    depositAmount: { type: Number, default: 1.00 },
    depositPackages: [
        {
            name: { type: String, default: 'Standard' },
            amount: { type: Number, default: 1.00 },
            description: { type: String, default: '1 queue slot' },
            isActive: { type: Boolean, default: true }
        }
    ],
    bankDetails: {
        accountTitle: { type: String, default: 'Admin' },
        accountNumber: { type: String, default: '1234567890' },
        bankName: { type: String, default: 'EasyPaisa' },
        additionalInstructions: { type: String, default: 'Please send exact amount' },
        isActive: { type: Boolean, default: true }
    },
    // ═══ BONUS SETTINGS ═══
    signupBonus: { type: Number, default: 0.10 },
    referralBonus: { type: Number, default: 0.50 },
    // ═══ WITHDRAWAL SETTINGS ═══
    minWithdrawal: { type: Number, default: 1.00 },
    // ═══ PAY PER REFER ═══
    payPerRefer: { type: Number, default: 1.00 },
    referralsPerPayout: { type: Number, default: 3 },
    // ═══ META ═══
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

// Singleton pattern — always use Settings.getSettings()
settingsSchema.statics.getSettings = async function () {
    let settings = await this.findOne();
    if (!settings) {
        settings = await this.create({});
    }
    return settings;
};

settingsSchema.statics.updateSettings = async function (updates, adminId) {
    let settings = await this.findOne();
    if (!settings) {
        settings = new this({});
    }
    Object.assign(settings, updates, { updatedBy: adminId });
    await settings.save();
    return settings;
};

module.exports = mongoose.model('Settings', settingsSchema);
