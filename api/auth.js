const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════
// REGISTER (with optional referral code)
// ═══════════════════════════════════════════════════
router.post('/register', asyncHandler(async (req, res) => {
    const { username, email, password, referralCode } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ message: 'All fields are required' });
    }

    // Get dynamic settings
    const settings = await Settings.getSettings();
    const SIGNUP_BONUS = settings.signupBonus;

    // Check existing
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
        return res.status(400).json({
            message: existing.username === username ? 'Username already taken' : 'Email already in use'
        });
    }

    // Find referrer if referral code provided
    let referrer = null;
    if (referralCode) {
        // Case-insensitive search for referral code (1dollar.username.random)
        referrer = await User.findOne({
            referralCode: { $regex: new RegExp(`^${referralCode}$`, "i") },
            status: { $ne: 'banned' }
        });
        if (!referrer) {
            return res.status(400).json({ message: 'Invalid referral code' });
        }
    }

    // Create user
    const user = new User({
        username,
        email,
        password,
        referredBy: referrer?._id || null,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || '',
    });
    await user.save();

    // Generate and set referral code (1dollar.username.random)
    user.referralCode = user.generateReferralCode();
    await user.save();

    // ═══ SIGNUP BONUS ═══
    user.wallet.balance = SIGNUP_BONUS;
    user.wallet.totalEarned = SIGNUP_BONUS;
    user.wallet.signupBonus = SIGNUP_BONUS;
    await user.save();

    // Create signup bonus transaction
    await new Transaction({
        userId: user._id,
        type: 'signup_bonus',
        amount: SIGNUP_BONUS,
        status: 'completed',
        description: `🚀 Account created! Received $${SIGNUP_BONUS.toFixed(2)} signup bonus.`
    }).save();

    // ═══ REFERRAL TRACKING (bonus deferred until deposit verified) ═══
    if (referrer) {
        // Anti-fraud check
        const sameIpReferrals = await User.countDocuments({
            referredBy: referrer._id,
            ipAddress: user.ipAddress,
            _id: { $ne: user._id }
        });

        if (sameIpReferrals >= 3) {
            user.flaggedForFraud = true;
            user.fraudReason = `Duplicate IP registration (${sameIpReferrals + 1} users on same IP)`;
            await user.save();
        } else {
            // Track the referral count but DO NOT give bonus yet
            // Bonus is given when the referred user's deposit is verified
            referrer.referralCount += 1;
            await referrer.save();

            // Track Grand-child for Grand-parent (if exists)
            if (referrer.referredBy) {
                const grandParent = await User.findById(referrer.referredBy);
                if (grandParent) {
                    grandParent.grandReferralCount = (grandParent.grandReferralCount || 0) + 1;
                    await grandParent.save();
                }
            }

            // Notify referrer (deposit pending)
            if (req.io) {
                req.io.emit(`notification:${referrer._id}`, {
                    title: '👤 New Referral Signup!',
                    body: `${username} registered using your link! They need to complete deposit for you to earn.`,
                    type: 'referral'
                });
            }
        }
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    logger.info('AUTH', `User registered: ${username}${referrer ? ` (referred by ${referrer.username})` : ''}`);

    // Admin alert
    if (req.io) {
        req.io.emit('admin:newUser', {
            title: '👤 New User Registered',
            body: `${username} just created an account${referrer ? ` (referred by ${referrer.username})` : ''}`,
            username,
            email,
            userId: user._id,
            referredBy: referrer?.username || null,
            timestamp: new Date().toISOString()
        });
    }

    res.status(201).json({
        message: `Account created successfully! You received $${SIGNUP_BONUS.toFixed(2)} signup bonus.`,
        token,
        user: {
            _id: user._id,
            username: user.username,
            email: user.email,
            wallet: user.wallet,
            status: user.status,
            referralCode: user.referralCode,
            referralCount: user.referralCount,
            depositStatus: user.depositStatus,
        }
    });
}));

// ═══════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════
router.post('/login', asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({ message: 'Invalid username or password' });
    }
    if (user.status === 'suspended') {
        return res.status(403).json({ message: 'Account has been suspended' });
    }
    if (user.status === 'banned') {
        return res.status(403).json({ message: 'Account has been banned. No further actions allowed.' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    logger.info('AUTH', `User logged in: ${username}`);

    res.json({
        token,
        user: {
            _id: user._id,
            username: user.username,
            email: user.email,
            wallet: user.wallet,
            status: user.status,
            referralCode: user.referralCode,
            referralCount: user.referralCount,
            depositStatus: user.depositStatus,
        }
    });
}));

// ═══════════════════════════════════════════════════
// CHANGE PASSWORD
// ═══════════════════════════════════════════════════
router.post('/change-password', auth, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Current password and new password are required' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }
    if (currentPassword === newPassword) {
        return res.status(400).json({ message: 'New password must be different from current password' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) return res.status(401).json({ message: 'Current password is incorrect' });

    user.password = newPassword;
    await user.save();

    logger.info('AUTH', `Password changed for user: ${user.username}`);
    res.json({ message: 'Password changed successfully' });
}));

module.exports = router;
