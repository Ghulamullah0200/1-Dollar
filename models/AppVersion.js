const mongoose = require('mongoose');

const appVersionSchema = new mongoose.Schema({
    latestVersion: { type: String, required: true, trim: true },
    apkUrl: { type: String, required: true, trim: true },
    forceUpdate: { type: Boolean, default: false },
    releaseNotes: { type: String, default: '' },
    minSupportedVersion: { type: String, default: '1.0.0' },
    checksum: { type: String, default: '' },
    fileSize: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    publishedAt: { type: Date, default: Date.now },
}, { timestamps: true });

appVersionSchema.index({ isActive: 1, publishedAt: -1 });

appVersionSchema.statics.getActiveVersion = async function () {
    return this.findOne({ isActive: true }).sort({ publishedAt: -1 }).lean();
};

module.exports = mongoose.model('AppVersion', appVersionSchema);
