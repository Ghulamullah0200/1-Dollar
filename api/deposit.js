const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const logger = require('../utils/logger');
const notificationService = require('../services/notificationService');

// ═══════════════════════════════════════════════════
// SUBMIT DEPOSIT
// ═══════════════════════════════════════════════════
router.post('/', auth, asyncHandler(async (req, res) => {
    const { proof, packageId } = req.body; // base64 image + selected package ID

    if (!proof) {
        return res.status(400).json({ message: 'Payment proof screenshot is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Block duplicate PENDING deposits
    if (user.depositStatus === 'pending') {
        return res.status(400).json({ message: 'You already have a pending deposit. Please wait for admin verification.' });
    }

    const settings = await Settings.getSettings();
    const amount = req.body.amount ? parseFloat(req.body.amount) : settings.depositAmount;

    if (!amount || amount <= 0) {
        return res.status(400).json({ message: 'Invalid deposit amount' });
    }

    // ═══ DETERMINE DEPOSIT TYPE ═══
    let depositType = 'platform_fees'; // default
    let packageName = '';

    if (packageId && settings.depositPackages && settings.depositPackages.length > 0) {
        const pkg = settings.depositPackages.find(p =>
            (p._id && p._id.toString() === packageId) || p.name === packageId
        );
        if (pkg) {
            depositType = pkg.type || 'platform_fees';
            packageName = pkg.name || '';
        }
    } else if (settings.depositPackages && settings.depositPackages.length > 0) {
        const pkg = settings.depositPackages.find(p => p.amount === amount && p.isActive);
        if (pkg) {
            depositType = pkg.type || 'platform_fees';
            packageName = pkg.name || '';
        }
    }

    // ═══ ENFORCE RULES ═══
    // Rule 1: If user has NOT paid verification fee, they can ONLY pay platform_fees
    if (!user.hasPaidVerificationFee && depositType === 'wallet_topup') {
        return res.status(400).json({
            message: 'You must pay the platform fees first before adding wallet balance.'
        });
    }

    // Rule 2: If user HAS paid verification fee and tries platform_fees again, block it
    if (user.hasPaidVerificationFee && depositType === 'platform_fees') {
        return res.status(400).json({
            message: 'Platform fees already paid. Select a wallet top-up package to add balance.'
        });
    }

    // ═══ SET TRANSIENT DEPOSIT STATUS (does NOT affect verification) ═══
    user.depositStatus = 'pending';
    user.depositProof = proof;
    user.depositAmount = amount;
    user.depositSubmittedAt = new Date();
    user.depositRejectionReason = '';
    user.pendingDepositType = depositType;
    user.pendingDepositPackageName = packageName;
    await user.save();

    // Create deposit transaction with proper type
    const txnType = depositType === 'platform_fees' ? 'verification' : 'wallet_topup';
    const txnDescription = depositType === 'platform_fees'
        ? `Platform Fees: $${amount.toFixed(2)} submitted for verification`
        : `Wallet Top-up: $${amount.toFixed(2)} submitted for verification${packageName ? ` (${packageName})` : ''}`;

    await new Transaction({
        userId: user._id,
        type: txnType,
        amount: amount,
        status: 'pending',
        depositType: depositType,
        packageName: packageName,
        description: txnDescription
    }).save();

    // Admin alert via Socket.IO
    const typeLabel = depositType === 'platform_fees' ? '🏷️ Platform Fees' : '💰 Wallet Top-up';
    if (req.io) {
        req.io.emit('admin:newDeposit', {
            title: `💵 ${typeLabel}`,
            body: `${user.username} submitted $${amount.toFixed(2)} (${typeLabel})`,
            username: user.username,
            userId: user._id,
            amount: amount,
            depositType: depositType,
            timestamp: new Date().toISOString()
        });
    }

    // Push notifications
    notificationService.sendToAdmins(
        `💵 ${typeLabel}`,
        `${user.username} submitted $${amount.toFixed(2)} (${typeLabel})`,
        { type: 'new_deposit', userId: user._id.toString(), depositType }
    ).catch(err => logger.error('DEPOSIT_PUSH', err.message));

    notificationService.sendToUser(
        user._id,
        'Deposit Submitted! 📝',
        `Your ${depositType === 'platform_fees' ? 'platform fees' : 'wallet top-up'} of $${amount.toFixed(2)} has been submitted.`,
        { type: 'deposit_submitted', depositType }
    ).catch(() => {});

    logger.info('DEPOSIT', `User ${user.username} submitted ${depositType} deposit of $${amount.toFixed(2)}`);

    res.json({
        message: 'Deposit submitted! Please wait for admin verification.',
        depositStatus: 'pending',
        depositAmount: amount,
        depositType
    });
}));

// ═══════════════════════════════════════════════════
// RE-SUBMIT DEPOSIT (after rejection)
// ═══════════════════════════════════════════════════
router.post('/resubmit', auth, asyncHandler(async (req, res) => {
    const { proof } = req.body;
    if (!proof) {
        return res.status(400).json({ message: 'Payment proof screenshot is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.depositStatus === 'pending') {
        return res.status(400).json({ message: 'You already have a pending deposit. Please wait for admin verification.' });
    }

    // Allow resubmit from 'rejected' or 'none' (for top-ups after verification)
    // For verified users who want to top up, they go through the main POST /
    if (user.depositStatus !== 'rejected' && user.depositStatus !== 'none') {
        return res.status(400).json({ message: 'You can only resubmit after a rejection.' });
    }

    const settings = await Settings.getSettings();
    const amount = req.body.amount ? parseFloat(req.body.amount) : (user.depositAmount || settings.depositAmount);

    // Determine type: if already verified, always wallet_topup
    let depositType = user.pendingDepositType || 'platform_fees';
    if (user.hasPaidVerificationFee) {
        depositType = 'wallet_topup';
    }

    user.depositStatus = 'pending';
    user.depositProof = proof;
    user.depositAmount = amount;
    user.depositSubmittedAt = new Date();
    user.depositRejectionReason = '';
    user.pendingDepositType = depositType;
    await user.save();

    const txnType = depositType === 'platform_fees' ? 'verification' : 'wallet_topup';
    await new Transaction({
        userId: user._id,
        type: txnType,
        amount: amount,
        status: 'pending',
        depositType: depositType,
        description: `Deposit resubmitted for $${amount.toFixed(2)} (${depositType === 'platform_fees' ? 'Platform Fees' : 'Wallet Top-up'})`
    }).save();

    if (req.io) {
        req.io.emit('admin:newDeposit', {
            title: '🔄 Deposit Resubmitted',
            body: `${user.username} resubmitted deposit proof`,
            username: user.username,
            userId: user._id,
            timestamp: new Date().toISOString()
        });
    }

    res.json({ message: 'Deposit resubmitted for verification', depositStatus: 'pending' });
}));

// ═══════════════════════════════════════════════════
// GET DEPOSIT STATUS
// ═══════════════════════════════════════════════════
router.get('/status', auth, asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).select(
        'depositStatus depositAmount depositSubmittedAt depositRejectionReason pendingDepositType hasPaidVerificationFee verificationApprovedAt'
    );
    if (!user) return res.status(404).json({ message: 'User not found' });

    const settings = await Settings.getSettings();

    res.json({
        depositStatus: user.depositStatus,
        depositAmount: user.depositAmount || settings.depositAmount,
        requiredAmount: settings.depositAmount,
        depositSubmittedAt: user.depositSubmittedAt,
        rejectionReason: user.depositRejectionReason,
        pendingDepositType: user.pendingDepositType,
        // New permanent verification fields
        hasPaidVerificationFee: user.hasPaidVerificationFee,
        verificationApprovedAt: user.verificationApprovedAt,
    });
}));

module.exports = router;
