const mongoose = require('mongoose');

const fakeUserSchema = new mongoose.Schema({
    username: { type: String, required: true, trim: true },
    avatar: { type: String, default: '' },
    country: { type: String, default: '' },
    earnings: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    referrals: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    joinDate: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
    importBatch: { type: String, default: '' }, // Track which import batch this user belongs to
}, { timestamps: true });

// Index for ranking queries
fakeUserSchema.index({ score: -1, referrals: -1 });
fakeUserSchema.index({ importBatch: 1 });
fakeUserSchema.index({ username: 1 });

module.exports = mongoose.model('FakeUser', fakeUserSchema);
