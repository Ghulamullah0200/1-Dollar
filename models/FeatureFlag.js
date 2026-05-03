const mongoose = require('mongoose');

const featureFlagSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, trim: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    description: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    category: {
        type: String,
        enum: ['system', 'feature', 'ui', 'notification'],
        default: 'feature',
        index: true
    },
}, { timestamps: true });

featureFlagSchema.index({ key: 1, enabled: 1 });

featureFlagSchema.statics.getAllFlags = async function () {
    const flags = await this.find({ enabled: true }).lean();
    const result = {};
    flags.forEach(f => { result[f.key] = f.value; });
    return result;
};

featureFlagSchema.statics.getFlag = async function (key, defaultValue = null) {
    const flag = await this.findOne({ key, enabled: true }).lean();
    return flag ? flag.value : defaultValue;
};

module.exports = mongoose.model('FeatureFlag', featureFlagSchema);
