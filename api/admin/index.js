const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../../models/User');
const Transaction = require('../../models/Transaction');
const Notification = require('../../models/Notification');
const AuditLog = require('../../models/AuditLog');
const Settings = require('../../models/Settings');
const FakeUser = require('../../models/FakeUser');
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

    // Notify user
    try {
        const notifTitle = '❌ Withdrawal Rejected';
        const notifBody = `Your withdrawal of $${transaction.amount.toFixed(2)} was rejected and refunded to your wallet.`;
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
        logger.warn('NOTIFICATION', 'Failed to create withdrawal rejection notification', notifErr.message);
    }

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
            .select('username email depositStatus depositAmount depositProof depositSubmittedAt depositRejectionReason referredBy pendingDepositType pendingDepositPackageName createdAt')
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

    const depositType = user.pendingDepositType || 'platform_fees';
    const depositAmount = user.depositAmount || 0;

    // Block: platform_fees already verified (use permanent flag)
    if (depositType === 'platform_fees' && user.hasPaidVerificationFee) {
        return res.status(400).json({ message: 'Platform fees already verified for this user' });
    }

    const settings = await Settings.getSettings();

    // ═══ WALLET TOP-UP: Add amount to user's wallet ═══
    if (depositType === 'wallet_topup') {
        user.wallet.balance += depositAmount;
        user.wallet.totalEarned += depositAmount;
        // Reset transient deposit status to 'none' so user can submit again immediately
        user.depositStatus = 'none';
        user.depositVerifiedAt = new Date();
        user.depositVerifiedBy = req.userId;
        user.depositRejectionReason = '';
        user.pendingDepositType = '';
        user.pendingDepositPackageName = '';
        await user.save();

        // Update transaction
        await Transaction.updateOne(
            { userId: user._id, type: { $in: ['deposit', 'wallet_topup'] }, status: 'pending' },
            { status: 'completed', processedBy: req.userId, processedAt: new Date() }
        );

        // Notify user
        const topupTitle = '✅ Wallet Top-up Verified!';
        const topupBody = `$${depositAmount.toFixed(2)} has been added to your wallet balance.`;
        await new Notification({
            title: topupTitle, body: topupBody,
            type: 'deposit', targetUserId: user._id, sentBy: req.userId,
        }).save();

        if (req.io) {
            req.io.emit(`notification:${user._id}`, { title: topupTitle, body: topupBody, type: 'deposit' });
        }
        fcmService.sendToUser(user._id, topupTitle, topupBody, { type: 'deposit' }).catch(() => { });

        logger.info('ADMIN', `Wallet top-up verified for ${user.username}: +$${depositAmount.toFixed(2)}`);
        return res.json({
            message: `Wallet top-up of $${depositAmount.toFixed(2)} verified for ${user.username}. Balance: $${user.wallet.balance.toFixed(2)}`
        });
    }

    // ═══ PLATFORM FEES: Permanently verify user account ═══
    // Set permanent verification flag (NEVER resets)
    user.hasPaidVerificationFee = true;
    user.verificationApprovedAt = new Date();
    // Reset transient deposit status to 'none' (ready for wallet top-ups)
    user.depositStatus = 'none';
    user.depositVerifiedAt = new Date();
    user.depositVerifiedBy = req.userId;
    user.depositRejectionReason = '';
    user.pendingDepositType = '';
    user.pendingDepositPackageName = '';

    // Update deposit transaction to completed
    const completedTxn = await Transaction.findOneAndUpdate(
        { userId: user._id, type: { $in: ['deposit', 'verification'] }, status: 'pending' },
        { status: 'completed', processedBy: req.userId, processedAt: new Date() },
        { new: true }
    );
    
    // Store verification transaction ID on user
    if (completedTxn) {
        user.verificationTransactionId = completedTxn._id;
    }
    await user.save();

    // ═══ REFERRAL BONUS — Only if BOTH referrer AND referred user are verified ═══
    if (user.referredBy) {
        const referrer = await User.findById(user.referredBy);
        if (referrer && !user.flaggedForFraud && referrer.hasPaidVerificationFee) {
            // Both the referrer and the referred user are now verified
            // Idempotent check — prevent duplicate reward
            const alreadyPaid = await Transaction.findOne({
                userId: referrer._id,
                type: 'referral_bonus',
                referredUserId: user._id,
                status: 'completed'
            });

            if (!alreadyPaid) {
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
            } else {
                logger.info('REFERRAL', `Duplicate prevention: bonus already paid to ${referrer.username} for ${user.username}`);
            }
        } else if (referrer && !user.flaggedForFraud && !referrer.hasPaidVerificationFee) {
            // Referrer is not yet verified — notify them they need to deposit first
            const pendingTitle = '⏳ Referral Bonus Pending';
            const pendingBody = `${user.username}'s deposit was verified, but you need to complete your own deposit first to earn the referral bonus.`;

            await new Notification({
                title: pendingTitle,
                body: pendingBody,
                type: 'referral',
                targetUserId: referrer._id,
                sentBy: req.userId,
            }).save();

            if (req.io) {
                req.io.emit(`notification:${referrer._id}`, { title: pendingTitle, body: pendingBody, type: 'referral' });
            }
            fcmService.sendToUser(referrer._id, pendingTitle, pendingBody, { type: 'referral' }).catch(() => { });

            logger.info('REFERRAL', `Bonus deferred for ${referrer.username} — referrer not verified`);
        }
    }

    // ═══ CHECK: Does newly verified user have referrals already verified? Pay deferred bonuses ═══
    const referredUsers = await User.find({
        referredBy: user._id,
        hasPaidVerificationFee: true,
        flaggedForFraud: { $ne: true }
    }).lean();

    for (const referredUser of referredUsers) {
        const existingBonus = await Transaction.findOne({
            userId: user._id,
            type: 'referral_bonus',
            referredUserId: referredUser._id,
            status: 'completed'
        });

        if (!existingBonus) {
            const REFERRAL_BONUS = settings.referralBonus;

            await User.findByIdAndUpdate(user._id, {
                $inc: {
                    'wallet.balance': REFERRAL_BONUS,
                    'wallet.totalEarned': REFERRAL_BONUS,
                    'wallet.referralEarnings': REFERRAL_BONUS
                }
            });

            await new Transaction({
                userId: user._id,
                type: 'referral_bonus',
                amount: REFERRAL_BONUS,
                status: 'completed',
                referredUserId: referredUser._id,
                description: `🤝 Deferred referral bonus! ${referredUser.username} was already verified. You earned $${REFERRAL_BONUS.toFixed(2)}`
            }).save();

            const deferredTitle = '💰 Referral Bonus Unlocked!';
            const deferredBody = `Your deposit is verified! You earned $${REFERRAL_BONUS.toFixed(2)} for referring ${referredUser.username}`;
            await new Notification({
                title: deferredTitle,
                body: deferredBody,
                type: 'referral',
                targetUserId: user._id,
                sentBy: req.userId,
            }).save();

            if (req.io) {
                req.io.emit(`notification:${user._id}`, { title: deferredTitle, body: deferredBody, type: 'referral' });
            }

            logger.info('REFERRAL', `Deferred bonus paid to ${user.username} for previously-verified referral ${referredUser.username}`);
        }
    }

    // Notify user
    const userNotifTitle = '✅ Deposit Verified!';
    const userNotifBody = 'Your platform fees have been verified. You now have full access to all features!';
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

    logger.info('ADMIN', `Platform fees verified for user ${user.username}`);
    res.json({ message: `Platform fees verified for ${user.username}` });
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
// BANK DETAILS MANAGEMENT
// ═══════════════════════════════════════════════════
router.get('/bank-details', adminAuth, asyncHandler(async (req, res) => {
    const settings = await Settings.getSettings();
    // Use toObject() to ensure sub-document fields are correctly spread
    const bankDetails = settings.bankDetails ? settings.bankDetails.toObject() : {};

    res.json([{
        ...bankDetails,
        publishedAt: settings.updatedAt
    }]);
}));

router.post('/bank-details', adminAuth, asyncHandler(async (req, res) => {
    const { accountNumber, bankName, accountTitle, additionalInstructions } = req.body;

    logger.info('ADMIN', `Bank details save request: ${JSON.stringify({ accountNumber, bankName, accountTitle, additionalInstructions })}`);

    // Use findOneAndUpdate with $set to guarantee atomic persistence
    // (Object.assign / direct assignment on subdocuments can silently fail in Mongoose)
    let settings = await Settings.findOne();
    if (!settings) {
        settings = await Settings.create({});
    }

    const updatedSettings = await Settings.findOneAndUpdate(
        { _id: settings._id },
        {
            $set: {
                'bankDetails.accountNumber': accountNumber,
                'bankDetails.bankName': bankName || '',
                'bankDetails.accountTitle': accountTitle,
                'bankDetails.additionalInstructions': additionalInstructions || '',
                'bankDetails.isActive': true,
                updatedBy: req.userId
            }
        },
        { new: true }
    );

    logger.info('ADMIN', `Bank details SAVED to DB. Verified: ${JSON.stringify(updatedSettings.bankDetails)}`);

    // Broadcast bank details to clients
    if (req.io) {
        req.io.emit('bankDetailsUpdated', updatedSettings.bankDetails);
    }

    logger.info('ADMIN', `Bank details updated by ${req.userId}`);
    res.json({ message: 'Bank details published successfully', bankDetails: updatedSettings.bankDetails });
}));

// ═══════════════════════════════════════════════════
router.get('/settings', adminAuth, asyncHandler(async (req, res) => {
    const settings = await Settings.getSettings();
    res.json(settings);
}));

router.post('/settings', adminAuth, asyncHandler(async (req, res) => {
     const { depositAmount, depositPackages, signupBonus, referralBonus, minWithdrawal, payPerRefer, referralsPerPayout, bankDetails, withdrawalBanks } = req.body;
    const updates = {};
    if (depositAmount !== undefined) updates.depositAmount = parseFloat(depositAmount);
    if (depositPackages !== undefined) updates.depositPackages = depositPackages;
    if (signupBonus !== undefined) updates.signupBonus = parseFloat(signupBonus);
    if (referralBonus !== undefined) updates.referralBonus = parseFloat(referralBonus);
    if (minWithdrawal !== undefined) updates.minWithdrawal = parseFloat(minWithdrawal);
    if (payPerRefer !== undefined) updates.payPerRefer = parseFloat(payPerRefer);
    if (referralsPerPayout !== undefined) updates.referralsPerPayout = parseInt(referralsPerPayout);
    if (bankDetails !== undefined) updates.bankDetails = bankDetails;
     if (withdrawalBanks !== undefined) updates.withdrawalBanks = withdrawalBanks;

    const settings = await Settings.updateSettings(updates, req.userId);

    // Broadcast updates to all connected clients
    if (req.io) {
        if (bankDetails) {
            req.io.emit('bankDetailsUpdated', settings.bankDetails);
        }
        if (depositAmount !== undefined || depositPackages !== undefined) {
            req.io.emit('depositAmountUpdated', { depositAmount: settings.depositAmount });
            req.io.emit('depositSettingsUpdated', {
                depositAmount: settings.depositAmount,
                depositPackages: settings.depositPackages
            });
        }
    }

    logger.info('ADMIN', `Settings updated: ${JSON.stringify(updates)}`);
    res.json({ message: 'Settings updated successfully', settings });
}));

// ═══════════════════════════════════════════════════
// PUBLIC RANKING — Hybrid (Real + Fake users merged)
// ═══════════════════════════════════════════════════
router.get('/public-ranking', asyncHandler(async (req, res) => {
    // Fetch real verified users
    const realUsers = await User.find({ status: { $ne: 'admin' }, hasPaidVerificationFee: true })
        .select('username referralCount wallet.referralEarnings createdAt')
        .sort({ referralCount: -1 })
        .limit(200)
        .lean();

    // Fetch active fake users
    const fakeUsers = await FakeUser.find({ isActive: true })
        .select('username referrals earnings score joinDate avatar country')
        .sort({ score: -1 })
        .limit(7000)
        .lean();

    // Normalize both into a common shape
    const normalizedReal = realUsers.map(u => ({
        _id: u._id,
        username: u.username,
        referralCount: u.referralCount || 0,
        earnings: u.wallet?.referralEarnings || 0,
        score: (u.referralCount || 0) * 10 + (u.wallet?.referralEarnings || 0) * 5,
        joinDate: u.createdAt,
        isFake: false,
    }));

    const normalizedFake = fakeUsers.map(u => ({
        _id: u._id,
        username: u.username,
        referralCount: u.referrals || 0,
        earnings: u.earnings || 0,
        score: u.score || 0,
        joinDate: u.joinDate,
        avatar: u.avatar,
        country: u.country,
        isFake: true,
    }));

    // Merge and sort by score descending
    // Real users with high activity will organically outrank fake users
    const merged = [...normalizedReal, ...normalizedFake]
        .sort((a, b) => b.score - a.score)
        .slice(0, 100);

    // Strip the isFake flag from public response (clients shouldn't know)
    const ranking = merged.map(({ isFake, ...rest }) => rest);

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
         withdrawalBanks: settings.withdrawalBanks || [],
    });
}));

// ═══════════════════════════════════════════════════
// PUBLIC BANK DETAILS (for client deposit page)
// ═══════════════════════════════════════════════════
router.get('/public-bank-details', asyncHandler(async (req, res) => {
    const settings = await Settings.getSettings();
    if (settings && settings.bankDetails && settings.bankDetails.isActive) {
        res.json(settings.bankDetails.toObject());
    } else {
        res.status(404).json({ message: 'Bank details not configured or inactive' });
    }
}));

// ═══════════════════════════════════════════════════
// PUBLIC DEPOSIT SETTINGS (for client deposit page)
// ═══════════════════════════════════════════════════
router.get('/public-deposit-settings', asyncHandler(async (req, res) => {
    const settings = await Settings.getSettings();
    res.json({
        depositAmount: settings.depositAmount,
        depositPackages: settings.depositPackages || []
    });
}));

// ═══════════════════════════════════════════════════
// FAKE USER MANAGEMENT (Admin only)
// ═══════════════════════════════════════════════════

// Download CSV template — only fields shown on client ranking page
router.get('/fake-users/template', adminAuth, (req, res) => {
    const csvHeader = 'username,referrals';
    const sampleRow1 = 'ahmed_khan,45';
    const sampleRow2 = 'sara_ali,38';
    const sampleRow3 = 'usman_99,27';
    const sampleRow4 = 'fatima_noor,19';
    const csv = [csvHeader, sampleRow1, sampleRow2, sampleRow3, sampleRow4].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=fake_users_template.csv');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).send(csv);
});

// Flush ALL fake users (complete wipe)
router.delete('/fake-users/flush', adminAuth, asyncHandler(async (req, res) => {
    const result = await FakeUser.deleteMany({});
    logger.info('ADMIN', `FLUSHED all fake users: ${result.deletedCount} deleted`);
    res.json({ message: `Flushed ${result.deletedCount} fake users`, deleted: result.deletedCount });
}));

// Bulk import fake users from CSV data (JSON payload with rows)
router.post('/fake-users/import', adminAuth, asyncHandler(async (req, res) => {
    const { rows } = req.body; // Array of objects with CSV fields

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: 'No data to import. Send { rows: [...] }' });
    }

    if (rows.length > 5000) {
        return res.status(400).json({ message: 'Maximum 5000 rows per import' });
    }
  
    const importBatch = `import_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const errors = [];
    const newRows = [];
    const updateRows = [];

    // Build lookup of existing fake usernames → _id for upsert
    const existingFakes = await FakeUser.find({}).select('username').lean();
    const fakeUsernameMap = new Map(); // lowercase username → doc _id
    existingFakes.forEach(f => fakeUsernameMap.set(f.username.toLowerCase(), f._id));

    // Check real usernames — these should be skipped (real user collision)
    const realUsernames = new Set();
    const existingReals = await User.find({ status: { $ne: 'admin' } }).select('username').lean();
    existingReals.forEach(r => realUsernames.add(r.username.toLowerCase()));

    const seenInBatch = new Set();

    rows.forEach((row, idx) => {
        const lineNum = idx + 1;

        // Validate username (required)
        if (!row.username || typeof row.username !== 'string' || row.username.trim().length === 0) {
            errors.push({ line: lineNum, field: 'username', error: 'Username is required' });
            return;
        }

        const username = row.username.trim();
        const usernameLower = username.toLowerCase();

        // Skip if it collides with a REAL user
        if (realUsernames.has(usernameLower)) {
            errors.push({ line: lineNum, field: 'username', error: `"${username}" matches a real user (skipped)` });
            return;
        }

        // Skip duplicates within the same CSV batch
        if (seenInBatch.has(usernameLower)) {
            errors.push({ line: lineNum, field: 'username', error: `"${username}" duplicate in CSV (skipped)` });
            return;
        }

        // Validate numbers
        const earnings = parseFloat(row.earnings) || 0;
        const wins = parseInt(row.wins) || 0;
        const referrals = parseInt(row.referrals) || 0;
        const score = parseInt(row.score) || (referrals * 10 + earnings * 5); // Auto-calculate if not provided

        // Validate joinDate
        let joinDate = new Date();
        if (row.joinDate) {
            const parsed = new Date(row.joinDate);
            if (!isNaN(parsed.getTime())) {
                joinDate = parsed;
            }
        }

        seenInBatch.add(usernameLower);

        const rowData = {
            username,
            avatar: (row.avatar || '').trim(),
            country: (row.country || '').trim(),
            earnings,
            wins,
            referrals,
            score,
            joinDate,
            importBatch,
            isActive: true,
        };

        // If this fake user already exists → update it; otherwise → insert new
        if (fakeUsernameMap.has(usernameLower)) {
            updateRows.push({ _id: fakeUsernameMap.get(usernameLower), ...rowData });
        } else {
            newRows.push(rowData);
        }
    });

    let inserted = 0;
    let updated = 0;

    // Insert new fake users
    if (newRows.length > 0) {
        const result = await FakeUser.insertMany(newRows, { ordered: false }).catch(err => {
            if (err.insertedDocs) return err.insertedDocs;
            throw err;
        });
        inserted = Array.isArray(result) ? result.length : newRows.length;
    }

    // Update existing fake users with new data
    if (updateRows.length > 0) {
        const bulkOps = updateRows.map(row => ({
            updateOne: {
                filter: { _id: row._id },
                update: {
                    $set: {
                        referrals: row.referrals,
                        earnings: row.earnings,
                        wins: row.wins,
                        score: row.score,
                        avatar: row.avatar,
                        country: row.country,
                        joinDate: row.joinDate,
                        importBatch: row.importBatch,
                        isActive: true,
                    }
                }
            }
        }));
        const bulkResult = await FakeUser.bulkWrite(bulkOps, { ordered: false });
        updated = bulkResult.modifiedCount || 0;
    }

    logger.info('ADMIN', `Fake users imported: ${inserted} inserted, ${updated} updated, ${errors.length} errors, batch: ${importBatch}`);

    res.json({
        message: `Import complete: ${inserted} added, ${updated} updated`,
        imported: inserted,
        updated,
        errors: errors.slice(0, 50), // Limit error response
        totalErrors: errors.length,
        batch: importBatch,
    });
}));

// List fake users
router.get('/fake-users', adminAuth, asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const [fakeUsers, total] = await Promise.all([
        FakeUser.find()
            .sort({ score: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        FakeUser.countDocuments()
    ]);

    res.json({
        fakeUsers,
        pagination: paginationMeta(page, limit, total)
    });
}));

// Delete a single fake user
router.delete('/fake-users/:id', adminAuth, asyncHandler(async (req, res) => {
    const result = await FakeUser.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ message: 'Fake user not found' });
    res.json({ message: 'Fake user deleted' });
}));

// Delete all fake users or by batch
router.post('/fake-users/clear', adminAuth, asyncHandler(async (req, res) => {
    const { batch } = req.body;
    let query = {};
    if (batch) query.importBatch = batch;

    const result = await FakeUser.deleteMany(query);
    logger.info('ADMIN', `Cleared ${result.deletedCount} fake users${batch ? ` (batch: ${batch})` : ''}`);
    res.json({ message: `Deleted ${result.deletedCount} fake users`, deleted: result.deletedCount });
}));

// Toggle fake user active status
router.post('/fake-users/:id/toggle', adminAuth, asyncHandler(async (req, res) => {
    const fakeUser = await FakeUser.findById(req.params.id);
    if (!fakeUser) return res.status(404).json({ message: 'Fake user not found' });

    fakeUser.isActive = !fakeUser.isActive;
    await fakeUser.save();
    res.json({ message: `Fake user ${fakeUser.isActive ? 'activated' : 'deactivated'}`, isActive: fakeUser.isActive });
}));

// Get import history
router.get('/fake-users/imports', adminAuth, asyncHandler(async (req, res) => {
    const imports = await FakeUser.aggregate([
        { $group: {
            _id: '$importBatch',
            count: { $sum: 1 },
            firstImported: { $min: '$createdAt' },
            active: { $sum: { $cond: ['$isActive', 1, 0] } },
        }},
        { $sort: { firstImported: -1 } },
        { $limit: 50 }
    ]);

    res.json({ imports });
}));

module.exports = router;
