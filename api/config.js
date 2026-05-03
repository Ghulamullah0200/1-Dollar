const express = require('express');
const router = express.Router();
const AppVersion = require('../models/AppVersion');
const FeatureFlag = require('../models/FeatureFlag');
const { adminAuth } = require('../middleware/auth');
const { asyncHandler, compareVersions } = require('../utils/helpers');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════
// PUBLIC: App Version Check
// ═══════════════════════════════════════════════════
router.get('/app-version', asyncHandler(async (req, res) => {
    const versionConfig = await AppVersion.getActiveVersion();
    if (!versionConfig) {
        return res.json({
            latestVersion: '1.0.0',
            apkUrl: process.env.APK_DOWNLOAD_URL || '',
            forceUpdate: false,
            releaseNotes: '',
            minSupportedVersion: '1.0.0',
            checksum: '',
            fileSize: 0
        });
    }

    const clientVersion = req.query.currentVersion;
    let updateRequired = false;
    let updateType = 'none';

    if (clientVersion) {
        const isOutdated = compareVersions(clientVersion, versionConfig.latestVersion) < 0;
        const isBelowMinimum = compareVersions(clientVersion, versionConfig.minSupportedVersion) < 0;

        if (isBelowMinimum || (isOutdated && versionConfig.forceUpdate)) {
            updateRequired = true;
            updateType = 'force';
        } else if (isOutdated) {
            updateRequired = true;
            updateType = 'optional';
        }
    }

    res.json({
        latestVersion: versionConfig.latestVersion,
        apkUrl: versionConfig.apkUrl,
        forceUpdate: versionConfig.forceUpdate,
        releaseNotes: versionConfig.releaseNotes,
        minSupportedVersion: versionConfig.minSupportedVersion,
        checksum: versionConfig.checksum,
        fileSize: versionConfig.fileSize,
        updateRequired,
        updateType,
    });
}));

// ═══════════════════════════════════════════════════
// PUBLIC: Feature Flags
// ═══════════════════════════════════════════════════
router.get('/feature-flags', asyncHandler(async (req, res) => {
    const flags = await FeatureFlag.getAllFlags();
    res.json(flags);
}));

// ═══════════════════════════════════════════════════
// ADMIN: Manage App Versions
// ═══════════════════════════════════════════════════
router.get('/admin/app-versions', adminAuth, asyncHandler(async (req, res) => {
    const versions = await AppVersion.find().sort({ publishedAt: -1 }).limit(20).lean();
    res.json(versions);
}));

router.post('/admin/app-version', adminAuth, asyncHandler(async (req, res) => {
    const { latestVersion, apkUrl, forceUpdate, releaseNotes, minSupportedVersion, checksum, fileSize } = req.body;

    if (!latestVersion || !apkUrl) {
        return res.status(400).json({ message: 'latestVersion and apkUrl are required' });
    }

    await AppVersion.updateMany({}, { $set: { isActive: false } });

    const version = new AppVersion({
        latestVersion,
        apkUrl,
        forceUpdate: forceUpdate || false,
        releaseNotes: releaseNotes || '',
        minSupportedVersion: minSupportedVersion || '1.0.0',
        checksum: checksum || '',
        fileSize: fileSize || 0,
        isActive: true,
    });
    await version.save();

    logger.info('CONFIG', `New app version published: ${latestVersion}`);
    res.json({ message: `Version ${latestVersion} published`, version });
}));

// ═══════════════════════════════════════════════════
// ADMIN: Manage Feature Flags
// ═══════════════════════════════════════════════════
router.get('/admin/feature-flags', adminAuth, asyncHandler(async (req, res) => {
    const flags = await FeatureFlag.find().sort({ category: 1, key: 1 }).lean();
    res.json(flags);
}));

router.post('/admin/feature-flag', adminAuth, asyncHandler(async (req, res) => {
    const { key, value, description, enabled, category } = req.body;
    if (!key) return res.status(400).json({ message: 'key is required' });

    const flag = await FeatureFlag.findOneAndUpdate(
        { key },
        { value, description, enabled: enabled !== false, category: category || 'feature' },
        { upsert: true, new: true }
    );

    logger.info('CONFIG', `Feature flag updated: ${key} = ${JSON.stringify(value)}`);
    res.json({ message: `Flag "${key}" updated`, flag });
}));

router.delete('/admin/feature-flag/:key', adminAuth, asyncHandler(async (req, res) => {
    await FeatureFlag.deleteOne({ key: req.params.key });
    logger.info('CONFIG', `Feature flag deleted: ${req.params.key}`);
    res.json({ message: `Flag "${req.params.key}" deleted` });
}));

module.exports = router;
