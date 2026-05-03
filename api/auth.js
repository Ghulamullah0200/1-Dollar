const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const logger = require('../utils/logger');

const SIGNUP_BONUS = parseFloat(process.env.SIGNUP_BONUS) || 0.10;
const REFERRAL_BONUS = parseFloat(process.env.REFERRAL_BONUS) || 0.50;

// ═══════════════════════════════════════════════════
// REGISTER (with optional referral code)
// ═══════════════════════════════════════════════════
router.post('/register', asyncHandler(async (req, res) => {
    const { username, email, password, referralCode } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ message: 'All fields are required' });
    }

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
        referrer = await User.findOne({ referralCode: referralCode.toUpperCase(), status: { $ne: 'banned' } });
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

    // Generate and set referral code
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
        description: `Signup bonus of $${SIGNUP_BONUS.toFixed(2)}`
    }).save();

    // ═══ REFERRAL BONUS TO REFERRER ═══
    if (referrer) {
        // Anti-fraud: check if same IP already referred
        const sameIpReferrals = await User.countDocuments({
            referredBy: referrer._id,
            ipAddress: user.ipAddress,
            _id: { $ne: user._id }
        });

        if (sameIpReferrals >= 3) {
            // Flag for fraud but still allow signup
            user.flaggedForFraud = true;
            user.fraudReason = `Multiple accounts from same IP (${sameIpReferrals + 1} accounts)`;
            await user.save();
            logger.warn('FRAUD', `User ${username} flagged — same IP as ${sameIpReferrals} other referrals of ${referrer.username}`);
        } else {
            // Credit referral bonus
            referrer.wallet.balance += REFERRAL_BONUS;
            referrer.wallet.totalEarned += REFERRAL_BONUS;
            referrer.wallet.referralEarnings += REFERRAL_BONUS;
            referrer.referralCount += 1;
            await referrer.save();

            // Create referral bonus transaction
            await new Transaction({
                userId: referrer._id,
                type: 'referral_bonus',
                amount: REFERRAL_BONUS,
                status: 'completed',
                referredUserId: user._id,
                description: `Referral bonus — ${username} signed up using your link`
            }).save();

            // Notify referrer via socket
            if (req.io) {
                req.io.emit(`notification:${referrer._id}`, {
                    title: '🎉 New Referral!',
                    body: `${username} signed up using your referral link! You earned $${REFERRAL_BONUS.toFixed(2)}`,
                    type: 'referral'
                });
            }

            logger.info('REFERRAL', `${referrer.username} earned $${REFERRAL_BONUS} from ${username}'s signup`);
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
