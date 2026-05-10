const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const notificationService = require('../services/notificationService');

// ═══════════════════════════════════════════════════
// REQUEST WITHDRAWAL
// ═══════════════════════════════════════════════════
router.post('/', auth, asyncHandler(async (req, res) => {
    const { amount, accountDetails } = req.body;
    const withdrawAmount = parseFloat(amount);

    const settings = await Settings.getSettings();
    const MIN_WITHDRAWAL = settings.minWithdrawal;

    if (!withdrawAmount || withdrawAmount <= 0) {
        return res.status(400).json({ message: 'Invalid withdrawal amount' });
    }

    if (withdrawAmount < MIN_WITHDRAWAL) {
        return res.status(400).json({ message: `Minimum withdrawal is $${MIN_WITHDRAWAL.toFixed(2)}` });
    }

    const userCheck = await User.findById(req.userId);

    // Check deposit verification
    if (userCheck.depositStatus !== 'verified') {
        return res.status(403).json({ message: 'Your deposit must be verified before you can withdraw. Please complete the deposit first.' });
    }

    if (userCheck.status === 'banned') {
        return res.status(403).json({ message: 'Account banned. No further actions allowed.' });
    }
    if (userCheck.flaggedForFraud) {
        return res.status(403).json({ message: 'Account under review. Please contact support.' });
    }

    // Check for existing pending withdrawal
    const pendingWithdrawal = await Transaction.findOne({
        userId: req.userId,
        type: 'withdrawal',
        status: 'pending'
    });
    if (pendingWithdrawal) {
        return res.status(400).json({ message: 'You already have a pending withdrawal request' });
    }

    // Atomic deduction
    const user = await User.findOneAndUpdate(
        { _id: req.userId, 'wallet.balance': { $gte: withdrawAmount } },
        { $inc: { 'wallet.balance': -withdrawAmount } },
        { new: true }
    );

    if (!user) {
        return res.status(400).json({ message: 'Insufficient balance' });
    }

    if (accountDetails) {
        user.accountDetails = accountDetails;
        await user.save();
    }

    const withdrawal = new Transaction({
        userId: req.userId,
        type: 'withdrawal',
        amount: withdrawAmount,
        accountDetails: accountDetails || user.accountDetails,
        status: 'pending',
        description: `Withdrawal request for $${withdrawAmount.toFixed(2)}`
    });
    await withdrawal.save();

    // Admin alert
    if (req.io) {
        req.io.emit('admin:newWithdrawal', {
            title: '📤 New Withdrawal Request',
            body: `${user.username} requested a $${withdrawAmount.toFixed(2)} withdrawal`,
            username: user.username,
            amount: withdrawAmount,
            withdrawalId: withdrawal._id,
            timestamp: new Date().toISOString()
        });
    }

    
    // PUSH NOTIFICATION FOR ADMINS
    notificationService.sendToAdmins(
        '📤 New Withdrawal Request',
        `${user.username} requested a $${withdrawAmount.toFixed(2)} withdrawal`,
        { type: 'new_withdrawal', withdrawalId: withdrawal._id.toString() }
    ).catch(() => {});

    // PUSH NOTIFICATION FOR USER
    const logger = require('../utils/logger');
    notificationService.sendToUser(
        user._id,
        'Withdrawal Submitted! 📤',
        `Your withdrawal request for $${withdrawAmount.toFixed(2)} has been submitted and is being processed.`,
        { type: 'withdrawal_submitted' }
    ).catch(() => {});
    
    res.json({ message: 'Withdrawal request submitted!', wallet: user.wallet });
}));

// ═══════════════════════════════════════════════════
// WITHDRAW ALL
// ═══════════════════════════════════════════════════
router.post('/all', auth, asyncHandler(async (req, res) => {
    const { accountDetails } = req.body;
    const user = await User.findById(req.userId);
    const settings = await Settings.getSettings();
    const MIN_WITHDRAWAL = settings.minWithdrawal;

    if (!user || user.wallet.balance <= 0) {
        return res.status(400).json({ message: 'No balance to withdraw' });
    }
    if (user.wallet.balance < MIN_WITHDRAWAL) {
        return res.status(400).json({ message: `Minimum withdrawal is $${MIN_WITHDRAWAL.toFixed(2)}` });
    }
    if (user.depositStatus !== 'verified') {
        return res.status(403).json({ message: 'Your deposit must be verified before you can withdraw.' });
    }
    if (user.status === 'banned') {
        return res.status(403).json({ message: 'Account banned. No further actions allowed.' });
    }
    if (user.flaggedForFraud) {
        return res.status(403).json({ message: 'Account under review. Please contact support.' });
    }

    // Check for existing pending withdrawal
    const pendingWithdrawal = await Transaction.findOne({
        userId: req.userId,
        type: 'withdrawal',
        status: 'pending'
    });
    if (pendingWithdrawal) {
        return res.status(400).json({ message: 'You already have a pending withdrawal request' });
    }

    const withdrawAmount = user.wallet.balance;

    const updated = await User.findOneAndUpdate(
        { _id: req.userId, 'wallet.balance': { $gte: withdrawAmount } },
        { $inc: { 'wallet.balance': -withdrawAmount } },
        { new: true }
    );

    if (!updated) return res.status(400).json({ message: 'Failed to process' });

    if (accountDetails) {
        updated.accountDetails = accountDetails;
        await updated.save();
    }

    const withdrawal = new Transaction({
        userId: req.userId,
        type: 'withdrawal',
        amount: withdrawAmount,
        accountDetails: accountDetails || updated.accountDetails,
        status: 'pending',
        description: `Full withdrawal of $${withdrawAmount.toFixed(2)}`
    });
    await withdrawal.save();

    // Admin alert
    if (req.io) {
        req.io.emit('admin:newWithdrawal', {
            title: '📤 Full Withdrawal Request',
            body: `${updated.username} requested full withdrawal of $${withdrawAmount.toFixed(2)}`,
            username: updated.username,
            amount: withdrawAmount,
            withdrawalId: withdrawal._id,
            timestamp: new Date().toISOString()
        });
    }

    res.json({ message: 'Full withdrawal submitted!', wallet: updated.wallet });
}));

// ═══════════════════════════════════════════════════
// CANCEL WITHDRAWAL
// ═══════════════════════════════════════════════════
router.post('/:id/cancel', auth, asyncHandler(async (req, res) => {
    const transaction = await Transaction.findOne({
        _id: req.params.id,
        userId: req.userId,
        type: 'withdrawal',
        status: 'pending'
    });

    if (!transaction) return res.status(404).json({ message: 'Pending withdrawal not found' });

    await User.findByIdAndUpdate(req.userId, {
        $inc: { 'wallet.balance': transaction.amount }
    });

    transaction.status = 'rejected';
    transaction.description += ' (Cancelled by user)';
    await transaction.save();

    const user = await User.findById(req.userId);
    res.json({ message: 'Withdrawal cancelled and refunded', wallet: user.wallet });
}));

module.exports = router;
