const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const Notification = require('../../models/Notification');
const AuditLog = require('../../models/AuditLog');
const Settings = require('../../models/Settings');
const { adminAuth } = require('../../middleware/auth');
const { asyncHandler, paginationMeta } = require('../../utils/helpers');
const logger = require('../../utils/logger');
const fcmService = require('../../services/notificationService');

// ═══════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════
router.get('/stats', adminAuth, asyncHandler(async (req, res) => {
    const [userStats] = await User.aggregate([
        { $match: { status: { $ne: 'admin' } } },
        {
            $group: {
                _id: null,
                totalUsers: { $sum: 1 },
                activeUsers: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
                suspendedUsers: { $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] } },
                bannedUsers: { $sum: { $cond: [{ $eq: ['$status', 'banned'] }, 1, 0] } },
                flaggedUsers: { $sum: { $cond: [{ $eq: ['$flaggedForFraud', true] }, 1, 0] } },
                totalReferrals: { $sum: '$referralCount' },
                totalUserBalances: {
                    $sum: {
                        $cond: [{ $eq: ['$status', 'active'] }, '$wallet.balance', 0]
                    }
                },
                totalEarnings: { $sum: '$wallet.totalEarned' },
            }
        }
    ]);

    const [withdrawalStats] = await Transaction.aggregate([
        { $match: { type: 'withdrawal' } },
        {
            $group: {
                _id: null,
                totalCompleted: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
                pendingCount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
                pendingAmount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$amount', 0] } },
            }
        }
    ]);

    res.json({
        totalUsers: userStats?.totalUsers || 0,
        activeUsers: userStats?.activeUsers || 0,
        suspendedUsers: userStats?.suspendedUsers || 0,
        bannedUsers: userStats?.bannedUsers || 0,
        flaggedUsers: userStats?.flaggedUsers || 0,
        totalReferrals: userStats?.totalReferrals || 0,
        totalUserBalances: userStats?.totalUserBalances || 0,
        totalEarnings: userStats?.totalEarnings || 0,
        totalWithdrawals: withdrawalStats?.totalCompleted || 0,
        pendingWithdrawals: withdrawalStats?.pendingCount || 0,
        pendingWithdrawalAmount: withdrawalStats?.pendingAmount || 0,
    });
}));

// ═══════════════════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/users', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const statusFilter = req.query.status;

    let query = { status: { $ne: 'admin' } };

    if (statusFilter) {
        if (statusFilter === 'flagged') {
            query.flaggedForFraud = true;
        } else {
            query.status = statusFilter;
        }
    }

    if (search) {
        query.$or = [
            { username: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
            { referralCode: { $regex: search, $options: 'i' } },
        ];
    }

    const [users, total] = await Promise.all([
        User.find(query)
            .select('-password')
            .populate('referredBy', 'username referralCode')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        User.countDocuments(query)
    ]);

    res.json({
        users,
        pagination: paginationMeta(page, limit, total)
    });
}));

// Get single user details
router.get('/users/:id', adminAuth, asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id)
        .select('-password')
        .populate('referredBy', 'username referralCode')
        .lean();

    if (!user) return res.status(404).json({ message: 'User not found' });

    // Get referrals made by this user
    const referrals = await User.find({ referredBy: user._id })
        .select('username email createdAt wallet.totalEarned status flaggedForFraud')
        .sort({ createdAt: -1 })
        .lean();

    // Get transactions
    const transactions = await Transaction.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();

    res.json({ user, referrals, transactions });
}));

// ═══════════════════════════════════════════════════
// USER ACTIONS
// ═══════════════════════════════════════════════════
router.post('/users/:id/suspend', adminAuth, asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { status: 'suspended' });
    logger.info('ADMIN', `User ${req.params.id} suspended`);
    res.json({ message: 'User suspended' });
}));

router.post('/users/:id/activate', adminAuth, asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, {
        status: 'active',
        flaggedForFraud: false,
        fraudReason: ''
    });
    res.json({ message: 'User activated' });
}));

router.post('/users/:id/ban', adminAuth, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    await User.findByIdAndUpdate(req.params.id, {
        status: 'banned',
        fraudReason: reason || 'Banned by admin'
    });
    logger.info('ADMIN', `User ${req.params.id} banned: ${reason || 'No reason'}`);
    res.json({ message: 'User banned' });
}));

router.post('/users/:id/add-balance', adminAuth, asyncHandler(async (req, res) => {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' });

    const user = await User.findByIdAndUpdate(
        req.params.id,
        { $inc: { 'wallet.balance': amount, 'wallet.totalEarned': amount } },
        { new: true }
    );
    res.json({ message: `$${amount} added`, wallet: user.wallet });
}));

router.post('/users/:id/reset-balance', adminAuth, asyncHandler(async (req, res) => {
    const user = await User.findByIdAndUpdate(
        req.params.id,
        {
            'wallet.balance': 0,
            'wallet.totalEarned': 0,
            'wallet.signupBonus': 0,
            'wallet.referralEarnings': 0,
        },
        { new: true }
    );
    res.json({ message: 'Balance reset', wallet: user.wallet });
}));

// ═══════════════════════════════════════════════════
// FRAUD DETECTION
// ═══════════════════════════════════════════════════
router.get('/fraud', adminAuth, asyncHandler(async (req, res) => {
    // Get flagged users
    const flaggedUsers = await User.find({ flaggedForFraud: true })
        .select('-password')
        .sort({ createdAt: -1 })
        .lean();

    // Detect duplicate IPs with multiple accounts
    const duplicateIPs = await User.aggregate([
        { $match: { status: { $ne: 'admin' }, ipAddress: { $ne: '' } } },
        { $group: { _id: '$ipAddress', count: { $sum: 1 }, users: { $push: { _id: '$_id', username: '$username', createdAt: '$createdAt' } } } },
        { $match: { count: { $gt: 2 } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
    ]);

    // Find users with suspiciously high referral counts
    const topReferrers = await User.find({ referralCount: { $gt: 10 } })
        .select('username referralCount wallet.referralEarnings flaggedForFraud createdAt')
        .sort({ referralCount: -1 })
        .limit(20)
        .lean();

    res.json({ flaggedUsers, duplicateIPs, topReferrers });
}));

router.post('/users/:id/flag-fraud', adminAuth, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    await User.findByIdAndUpdate(req.params.id, {
        flaggedForFraud: true,
        fraudReason: reason || 'Flagged by admin'
    });
    logger.info('FRAUD', `User ${req.params.id} flagged: ${reason || 'No reason'}`);
    res.json({ message: 'User flagged for fraud' });
}));

router.post('/users/:id/clear-fraud', adminAuth, asyncHandler(async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, {
        flaggedForFraud: false,
        fraudReason: ''
    });
    res.json({ message: 'Fraud flag cleared' });
}));

// ═══════════════════════════════════════════════════
// BULK DELETE USERS
// ═══════════════════════════════════════════════════
router.post('/users/cleanup', adminAuth, asyncHandler(async (req, res) => {
    const { statuses, confirm: confirmAction } = req.body;

    const validStatuses = ['suspended', 'banned'];
    const targetStatuses = statuses?.filter(s => validStatuses.includes(s)) || validStatuses;

    if (!confirmAction || confirmAction !== 'DELETE_ALL_CONFIRMED') {
        const counts = {};
        for (const status of targetStatuses) {
            counts[status] = await User.countDocuments({ status });
        }
        const flaggedCount = await User.countDocuments({ flaggedForFraud: true, status: { $ne: 'admin' } });
        counts.flagged = flaggedCount;

        return res.json({
            message: 'Preview mode — send confirm: "DELETE_ALL_CONFIRMED" to execute',
            preview: true,
            counts,
            totalToDelete: Object.values(counts).reduce((a, b) => a + b, 0),
        });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const usersToDelete = await User.find({
            $or: [
                { status: { $in: targetStatuses } },
                { flaggedForFraud: true, status: { $ne: 'admin' } }
            ]
        }).select('_id username status').session(session);

        const userIds = usersToDelete.map(u => u._id);
        const deleteCount = userIds.length;

        if (deleteCount === 0) {
            await session.abortTransaction();
            session.endSession();
            return res.json({ message: 'No users to delete', deleted: 0 });
        }

        const txnResult = await Transaction.deleteMany({ userId: { $in: userIds } }).session(session);
        const userResult = await User.deleteMany({ _id: { $in: userIds } }).session(session);

        await new AuditLog({
            action: 'user.bulk_delete',
            performedBy: req.userId,
            details: {
                deletedCount: deleteCount,
                statuses: targetStatuses,
                usernames: usersToDelete.map(u => u.username),
                transactionsDeleted: txnResult.deletedCount,
            }
        }).save({ session });

        await session.commitTransaction();
        session.endSession();

        logger.info('ADMIN', `Bulk deleted ${deleteCount} users`);
        res.json({
            message: `Successfully deleted ${deleteCount} users`,
            deleted: deleteCount,
            transactionsDeleted: txnResult.deletedCount,
        });
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err;
    }
}));

// ═══════════════════════════════════════════════════
// WITHDRAWAL MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/withdrawals', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const status = req.query.status;

    let query = { type: 'withdrawal' };
    if (status) query.status = status;

    const [withdrawals, total] = await Promise.all([
        Transaction.find(query)
            .populate('userId', 'username email accountDetails referralCount flaggedForFraud')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
        Transaction.countDocuments(query)
    ]);

    res.json({
        withdrawals,
        pagination: paginationMeta(page, limit, total)
    });
}));

router.post('/withdrawals/:id/approve', adminAuth, asyncHandler(async (req, res) => {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
        return res.status(404).json({ message: 'Pending withdrawal not found' });
    }

    transaction.status = 'completed';
    transaction.processedBy = req.userId;
    transaction.processedAt = new Date();
    await transaction.save();

    logger.info('ADMIN', `Withdrawal $${transaction.amount} approved for user ${transaction.userId}`);

    // Notify user
    try {
        const notifTitle = 'Withdrawal Approved 💰';
        const notifBody = `Your withdrawal of $${transaction.amount.toFixed(2)} has been processed! Amount has been sent to your account.`;
        const notif = await new Notification({
            title: notifTitle,
            body: notifBody,
            type: 'withdrawal',
            targetUserId: transaction.userId,
            metadata: { transactionId: transaction._id, amount: transaction.amount },
            sentBy: req.userId,
        }).save();

        fcmService.sendToUser(transaction.userId, notifTitle, notifBody, {
            notificationId: notif._id.toString(),
            type: 'withdrawal'
        }).catch(() => { });

        if (req.io) {
            req.io.emit(`notification:${transaction.userId}`, {
                title: notifTitle, body: notifBody, type: 'withdrawal'
            });
        }
    } catch (notifErr) {
        logger.warn('NOTIFICATION', 'Failed to create withdrawal notification', notifErr.message);
    }

    res.json({ message: 'Withdrawal approved and payment completed.' });
}));

router.post('/withdrawals/:id/reject', adminAuth, asyncHandler(async (req, res) => {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction || transaction.type !== 'withdrawal' || transaction.status !== 'pending') {
        return res.status(404).json({ message: 'Pending withdrawal not found' });
    }

    // Refund balance
    await User.findByIdAndUpdate(transaction.userId, {
        $inc: { 'wallet.balance': transaction.amount }
    });

    transaction.status = 'rejected';
    transaction.processedBy = req.userId;
    transaction.processedAt = new Date();
    await transaction.save();

    res.json({ message: 'Withdrawal rejected and refunded' });
}));

// ═══════════════════════════════════════════════════
// NOTIFICATION MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/notifications', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
        Notification.find()
            .populate('targetUserId', 'username')
            .populate('sentBy', 'username')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Notification.countDocuments()
    ]);

    res.json({
        notifications,
        pagination: paginationMeta(page, limit, total)
    });
}));

router.post('/notifications/send', adminAuth, asyncHandler(async (req, res) => {
    const { title, body, targetUserId } = req.body;

    if (!title || !body) {
        return res.status(400).json({ message: 'Title and body are required' });
    }

    const notification = new Notification({
        title,
        body,
        type: targetUserId ? 'manual' : 'broadcast',
        targetUserId: targetUserId || null,
        sentBy: req.userId,
    });
    await notification.save();

    if (targetUserId) {
        req.io.emit(`notification:${targetUserId}`, { title, body, type: 'manual' });
        fcmService.sendToUser(targetUserId, title, body, { notificationId: notification._id.toString() }).catch(() => { });
    } else {
        req.io.emit('notification:broadcast', { title, body, type: 'broadcast' });
        fcmService.sendBroadcast(title, body, { notificationId: notification._id.toString() }).catch(() => { });
    }

    logger.info('NOTIFICATION', `${targetUserId ? 'Manual' : 'Broadcast'} notification sent: "${title}"`);
    res.json({ message: 'Notification sent', notification });
}));

router.post('/notifications/broadcast', adminAuth, asyncHandler(async (req, res) => {
    const { title, body } = req.body;

    if (!title || !body) {
        return res.status(400).json({ message: 'Title and body are required' });
    }

    const notification = new Notification({
        title,
        body,
        type: 'broadcast',
        targetUserId: null,
        sentBy: req.userId,
    });
    await notification.save();

    req.io.emit('notification:broadcast', { title, body, type: 'broadcast', id: notification._id });

    const fcmResult = await fcmService.sendBroadcast(title, body, { notificationId: notification._id.toString() });

    logger.info('NOTIFICATION', `Broadcast sent: "${title}" | FCM: ${fcmResult.sent} sent, ${fcmResult.failed} failed`);
    res.json({ message: 'Broadcast notification sent to all users', notification, fcm: fcmResult });
}));

// ═══════════════════════════════════════════════════
// SETTINGS (Admin credentials)
// ═══════════════════════════════════════════════════
router.post('/update-credentials', adminAuth, asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    if (username) req.user.username = username;
    if (password) req.user.password = password;
    await req.user.save();
    res.json({ message: 'Admin credentials updated' });
}));

// ═══════════════════════════════════════════════════
// REFERRAL RANKING / LEADERBOARD
// ═══════════════════════════════════════════════════
router.get('/referral-ranking', adminAuth, asyncHandler(async (req, res) => {
    const ranking = await User.find({ status: { $ne: 'admin' } })
        .select('username referralCount grandReferralCount wallet.referralEarnings createdAt')
        .sort({ referralCount: -1, grandReferralCount: -1 })
        .limit(100)
        .lean();

    res.json({ ranking });
}));

// ═══════════════════════════════════════════════════
// AUDIT LOGS
// ═══════════════════════════════════════════════════
router.get('/audit-logs', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
        AuditLog.find()
            .populate('performedBy', 'username')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        AuditLog.countDocuments()
    ]);

    res.json({
        logs,
        pagination: paginationMeta(page, limit, total)
    });
}));

// ═══════════════════════════════════════════════════
// FRAUD DETECTION
// ═══════════════════════════════════════════════════
router.get('/fraud/duplicate-ips', adminAuth, asyncHandler(async (req, res) => {
    const duplicates = await User.aggregate([
        { $match: { status: { $ne: 'admin' }, lastIp: { $exists: true, $ne: null } } },
        {
            $group: {
                _id: "$lastIp",
                count: { $sum: 1 },
                users: { $push: { _id: "$_id", username: "$username", status: "$status", wallet: "$wallet" } }
            }
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } }
    ]);

    res.json({ duplicates });
}));

router.post('/fraud/bulk-action', adminAuth, asyncHandler(async (req, res) => {
    const { ip, action } = req.body;
    if (!ip || !['suspend', 'ban', 'flag'].includes(action)) {
        return res.status(400).json({ message: 'Invalid IP or action' });
    }

    let update = {};
    if (action === 'suspend') update = { status: 'suspended' };
    else if (action === 'ban') update = { status: 'banned' };
    else if (action === 'flag') update = { flaggedForFraud: true };

    const result = await User.updateMany(
        { lastIp: ip, status: { $ne: 'admin' } },
        { $set: update }
    );

    logger.warn('FRAUD', `Bulk ${action} performed on IP ${ip} | Affected: ${result.modifiedCount} accounts`);
    res.json({ message: `Bulk ${action} successful`, affected: result.modifiedCount });
}));

// ═══════════════════════════════════════════════════
// APP VERSIONING
// ═══════════════════════════════════════════════════
router.post('/app-version', adminAuth, asyncHandler(async (req, res) => {
    const { latestVersion, apkUrl, forceUpdate, releaseNotes, minSupportedVersion } = req.body;

    if (!latestVersion || !apkUrl) {
        return res.status(400).json({ message: 'Version and URL are required' });
    }

    // Deactivate previous versions
    await AppVersion.updateMany({}, { $set: { isActive: false } });

    const newVersion = new AppVersion({
        latestVersion,
        apkUrl,
        forceUpdate: !!forceUpdate,
        releaseNotes,
        minSupportedVersion: minSupportedVersion || '1.0.0',
        isActive: true,
        publishedAt: new Date(),
        publishedBy: req.userId
    });

    await newVersion.save();

    // Notify users about new update if force update
    if (forceUpdate) {
        req.io.emit('app:update', { version: latestVersion, force: true });
    }

    logger.info('SYSTEM', `New app version published: v${latestVersion}`);
    res.json({ message: 'New version published successfully', version: newVersion });
}));

// ═══════════════════════════════════════════════════
// DEPOSIT MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/deposits', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const status = req.query.status || 'pending';

    let query = { depositStatus: status };
    if (status === 'all') delete query.depositStatus;

    const [users, total] = await Promise.all([
        User.find({ ...query, status: { $ne: 'admin' } })
            .select('username email depositStatus depositAmount depositProof depositSubmittedAt depositRejectionReason referredBy createdAt')
            .populate('referredBy', 'username')
            .sort({ depositSubmittedAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        User.countDocuments({ ...query, status: { $ne: 'admin' } })
    ]);

    res.json({ deposits: users, pagination: paginationMeta(page, limit, total) });
}));

router.post('/deposits/:userId/verify', adminAuth, asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.depositStatus === 'verified') return res.status(400).json({ message: 'Already verified' });

    const settings = await Settings.getSettings();

    user.depositStatus = 'verified';
    user.depositVerifiedAt = new Date();
    user.depositVerifiedBy = req.userId;
    user.depositRejectionReason = '';
    await user.save();

    // Update deposit transaction to completed
    await Transaction.updateOne(
        { userId: user._id, type: 'deposit', status: 'pending' },
        { status: 'completed', processedBy: req.userId, processedAt: new Date() }
    );

    // ═══ NOW GIVE REFERRAL BONUS TO REFERRER ═══
    if (user.referredBy) {
        const referrer = await User.findById(user.referredBy);
        if (referrer && !user.flaggedForFraud) {
            const REFERRAL_BONUS = settings.referralBonus;

            referrer.wallet.balance += REFERRAL_BONUS;
            referrer.wallet.totalEarned += REFERRAL_BONUS;
            referrer.wallet.referralEarnings += REFERRAL_BONUS;
            await referrer.save();

            // Create referral bonus transaction
            await new Transaction({
                userId: referrer._id,
                type: 'referral_bonus',
                amount: REFERRAL_BONUS,
                status: 'completed',
                referredUserId: user._id,
                description: `🤝 Referral bonus! ${user.username}'s deposit verified. You earned $${REFERRAL_BONUS.toFixed(2)}`
            }).save();

            // Notify referrer
            const notifTitle = '💰 Referral Bonus Earned!';
            const notifBody = `${user.username}'s deposit was verified! You earned $${REFERRAL_BONUS.toFixed(2)}`;

            await new Notification({
                title: notifTitle,
                body: notifBody,
                type: 'referral',
                targetUserId: referrer._id,
                sentBy: req.userId,
            }).save();

            if (req.io) {
                req.io.emit(`notification:${referrer._id}`, { title: notifTitle, body: notifBody, type: 'referral' });
            }
            fcmService.sendToUser(referrer._id, notifTitle, notifBody, { type: 'referral' }).catch(() => { });
        }
    }

    // Notify user
    const userNotifTitle = '✅ Deposit Verified!';
    const userNotifBody = 'Your deposit has been verified. You now have full access to all features!';
    await new Notification({
        title: userNotifTitle,
        body: userNotifBody,
        type: 'deposit',
        targetUserId: user._id,
        sentBy: req.userId,
    }).save();

    if (req.io) {
        req.io.emit(`notification:${user._id}`, { title: userNotifTitle, body: userNotifBody, type: 'deposit' });
    }
    fcmService.sendToUser(user._id, userNotifTitle, userNotifBody, { type: 'deposit' }).catch(() => { });

    logger.info('ADMIN', `Deposit verified for user ${user.username}`);
    res.json({ message: `Deposit verified for ${user.username}` });
}));

router.post('/deposits/:userId/reject', adminAuth, asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.depositStatus = 'rejected';
    user.depositRejectionReason = reason || 'Deposit rejected by admin';
    await user.save();

    await Transaction.updateOne(
        { userId: user._id, type: 'deposit', status: 'pending' },
        { status: 'rejected', processedBy: req.userId, processedAt: new Date() }
    );

    // Notify user
    const notifTitle = '❌ Deposit Rejected';
    const notifBody = `Your deposit was rejected: ${user.depositRejectionReason}. Please resubmit.`;
    await new Notification({
        title: notifTitle,
        body: notifBody,
        type: 'deposit',
        targetUserId: user._id,
        sentBy: req.userId,
    }).save();

    if (req.io) {
        req.io.emit(`notification:${user._id}`, { title: notifTitle, body: notifBody, type: 'deposit' });
    }

    logger.info('ADMIN', `Deposit rejected for user ${user.username}: ${user.depositRejectionReason}`);
    res.json({ message: `Deposit rejected for ${user.username}` });
}));

// ═══════════════════════════════════════════════════
// DYNAMIC SETTINGS MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/settings', adminAuth, asyncHandler(async (req, res) => {
    const settings = await Settings.getSettings();
    res.json(settings);
}));

router.post('/settings', adminAuth, asyncHandler(async (req, res) => {
    const { depositAmount, signupBonus, referralBonus, minWithdrawal, payPerRefer, referralsPerPayout } = req.body;

    const updates = {};
    if (depositAmount !== undefined) updates.depositAmount = parseFloat(depositAmount);
    if (signupBonus !== undefined) updates.signupBonus = parseFloat(signupBonus);
    if (referralBonus !== undefined) updates.referralBonus = parseFloat(referralBonus);
    if (minWithdrawal !== undefined) updates.minWithdrawal = parseFloat(minWithdrawal);
    if (payPerRefer !== undefined) updates.payPerRefer = parseFloat(payPerRefer);
    if (referralsPerPayout !== undefined) updates.referralsPerPayout = parseInt(referralsPerPayout);

    const settings = await Settings.updateSettings(updates, req.userId);
    logger.info('ADMIN', `Settings updated: ${JSON.stringify(updates)}`);
    res.json({ message: 'Settings updated successfully', settings });
}));

// ═══════════════════════════════════════════════════
// PUBLIC RANKING (no auth needed)
// ═══════════════════════════════════════════════════
router.get('/public-ranking', asyncHandler(async (req, res) => {
    const ranking = await User.find({ status: { $ne: 'admin' }, depositStatus: 'verified' })
        .select('username referralCount')
        .sort({ referralCount: -1 })
        .limit(100)
        .lean();

    res.json({ ranking });
}));

// ═══════════════════════════════════════════════════
// PUBLIC SETTINGS (for client)
// ═══════════════════════════════════════════════════
router.get('/public-settings', asyncHandler(async (req, res) => {
    const settings = await Settings.getSettings();
    res.json({
        depositAmount: settings.depositAmount,
        signupBonus: settings.signupBonus,
        referralBonus: settings.referralBonus,
        minWithdrawal: settings.minWithdrawal,
        payPerRefer: settings.payPerRefer,
        referralsPerPayout: settings.referralsPerPayout,
    });
}));

module.exports = router;
