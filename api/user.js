const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Notification = require('../models/Notification');
const Settings = require('../models/Settings');
const { auth } = require('../middleware/auth');
const { asyncHandler, paginationMeta } = require('../utils/helpers');

// ═══════════════════════════════════════════════════
// USER STATUS (Dashboard data)
// ═══════════════════════════════════════════════════
router.get('/status', auth, asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    const settings = await Settings.getSettings();

    const referrals = await User.find({ referredBy: req.userId })
        .select('username createdAt depositStatus')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

    // Count only verified referrals for reward eligibility
    const verifiedReferralCount = referrals.filter(r => r.depositStatus === 'verified').length;

    const MIN_WITHDRAWAL = settings.minWithdrawal;

    res.json({
        wallet: user.wallet,
        status: user.status,
        username: user.username,
        email: user.email,
        referralCode: user.referralCode,
        referralCount: user.referralCount,
        verifiedReferralCount,
        referrals: referrals.map(r => ({
            username: r.username,
            createdAt: r.createdAt,
            depositStatus: r.depositStatus || 'none',
        })),
        withdrawalEligible: user.wallet.balance >= MIN_WITHDRAWAL,
        minWithdrawal: MIN_WITHDRAWAL,
        accountDetails: user.accountDetails,
        depositStatus: user.depositStatus,
        // Dynamic settings for client
        settings: {
            depositAmount: settings.depositAmount,
            signupBonus: settings.signupBonus,
            referralBonus: settings.referralBonus,
            minWithdrawal: settings.minWithdrawal,
            payPerRefer: settings.payPerRefer,
            referralsPerPayout: settings.referralsPerPayout,
            withdrawalBanks: settings.withdrawalBanks || [],
        }
    });
}));

// ═══════════════════════════════════════════════════
// GET WALLET
// ═══════════════════════════════════════════════════
router.get('/wallet', auth, asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId);
    res.json({
        wallet: user.wallet,
        referralCode: user.referralCode,
        referralCount: user.referralCount,
    });
}));

// ═══════════════════════════════════════════════════
// TRANSACTION HISTORY
// ═══════════════════════════════════════════════════
router.get('/transactions', auth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
        Transaction.find({ userId: req.userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Transaction.countDocuments({ userId: req.userId })
    ]);

    res.json({
        transactions,
        pagination: paginationMeta(page, limit, total)
    });
}));

// ═══════════════════════════════════════════════════
// USER NOTIFICATIONS
// ═══════════════════════════════════════════════════
router.get('/notifications', auth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
        Notification.find({
            $or: [
                { targetUserId: req.userId },
                { type: 'broadcast' }
            ]
        })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Notification.countDocuments({
            $or: [
                { targetUserId: req.userId },
                { type: 'broadcast' }
            ]
        })
    ]);

    const unreadCount = await Notification.countDocuments({
        $or: [
            { targetUserId: req.userId },
            { type: 'broadcast' }
        ],
        readBy: { $ne: req.userId }
    });

    res.json({
        notifications,
        unreadCount,
        pagination: paginationMeta(page, limit, total)
    });
}));

// Mark notifications as read
router.post('/notifications/read', auth, asyncHandler(async (req, res) => {
    const { notificationIds } = req.body;

    if (notificationIds?.length) {
        await Notification.updateMany(
            { _id: { $in: notificationIds } },
            { $addToSet: { readBy: req.userId } }
        );
    } else {
        await Notification.updateMany(
            {
                $or: [
                    { targetUserId: req.userId },
                    { type: 'broadcast' }
                ],
                readBy: { $ne: req.userId }
            },
            { $addToSet: { readBy: req.userId } }
        );
    }

    res.json({ message: 'Notifications marked as read' });
}));

// ═══════════════════════════════════════════════════
// PENDING NOTIFICATIONS
// ═══════════════════════════════════════════════════
router.get('/pending-notifications', auth, asyncHandler(async (req, res) => {
    const notifications = await Notification.find({
        $or: [
            { targetUserId: req.userId },
            { type: 'broadcast' }
        ],
        readBy: { $ne: req.userId }
    })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

    res.json({ notifications, count: notifications.length });
}));

// ═══════════════════════════════════════════════════
// FCM TOKEN REGISTRATION
// ═══════════════════════════════════════════════════
router.post('/fcm-token', auth, asyncHandler(async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'FCM token required' });

    await User.findByIdAndUpdate(req.userId, {
        fcmToken: token,
        lastActiveAt: new Date()
    });

    res.json({ message: 'FCM token registered' });
}));

// ═══════════════════════════════════════════════════
// UPDATE ACCOUNT DETAILS
// ═══════════════════════════════════════════════════
router.post('/account-details', auth, asyncHandler(async (req, res) => {
    const { accountTitle, accountNumber, bankName } = req.body;

    const user = await User.findByIdAndUpdate(
        req.userId,
        {
            accountDetails: {
                accountTitle: accountTitle || '',
                accountNumber: accountNumber || '',
                bankName: bankName || ''
            }
        },
        { new: true }
    );

    res.json({ message: 'Account details updated', accountDetails: user.accountDetails });
}));

module.exports = router;
