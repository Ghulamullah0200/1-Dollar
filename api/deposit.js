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
    // Find the matching package to get its type
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
        // Match by amount if no packageId
        const pkg = settings.depositPackages.find(p => p.amount === amount && p.isActive);
        if (pkg) {
            depositType = pkg.type || 'platform_fees';
            packageName = pkg.name || '';
        }
    }

    // ═══ ENFORCE RULES ═══
    // Rule 1: If user is NOT verified, they can ONLY pay platform_fees
    if (user.depositStatus !== 'verified' && depositType === 'wallet_topup') {
        return res.status(400).json({
            message: 'You must pay the platform fees first before adding wallet balance.'
        });
    }

    // Rule 2: If user IS verified and tries platform_fees again, block it
    if (user.depositStatus === 'verified' && depositType === 'platform_fees') {
        return res.status(400).json({
            message: 'Platform fees already paid. Select a wallet top-up package to add balance.'
        });
    }

    user.depositStatus = 'pending';
    user.depositProof = proof;
    user.depositAmount = amount;
    user.depositSubmittedAt = new Date();
    user.depositRejectionReason = '';
    // Store the deposit type so admin verify logic knows what to do
    user.pendingDepositType = depositType;
    user.pendingDepositPackageName = packageName;
    await user.save();

    // Create deposit transaction with type info
    const txnDescription = depositType === 'platform_fees'
        ? `Platform Fees: $${amount.toFixed(2)} submitted for verification`
        : `Wallet Top-up: $${amount.toFixed(2)} submitted for verification${packageName ? ` (${packageName})` : ''}`;

    await new Transaction({
        userId: user._id,
        type: 'deposit',
        amount: amount,
        status: 'pending',
        description: txnDescription,
        metadata: { depositType, packageName }
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

    if (user.depositStatus !== 'rejected' && user.depositStatus !== 'verified') {
        return res.status(400).json({ message: 'You can only resubmit after a rejection or verified status' });
    }

    const settings = await Settings.getSettings();
    const amount = req.body.amount ? parseFloat(req.body.amount) : (user.depositAmount || settings.depositAmount);

    // Determine type from the pending deposit or from the amount-matched package
    let depositType = user.pendingDepositType || 'platform_fees';
    if (user.depositStatus === 'verified') {
        depositType = 'wallet_topup'; // Verified user resubmitting is always a top-up
    }

    user.depositStatus = 'pending';
    user.depositProof = proof;
    user.depositAmount = amount;
    user.depositSubmittedAt = new Date();
    user.depositRejectionReason = '';
    user.pendingDepositType = depositType;
    await user.save();

    await new Transaction({
        userId: user._id,
        type: 'deposit',
        amount: amount,
        status: 'pending',
        description: `Deposit resubmitted for $${amount.toFixed(2)} (${depositType === 'platform_fees' ? 'Platform Fees' : 'Wallet Top-up'})`,
        metadata: { depositType }
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
    const user = await User.findById(req.userId).select('depositStatus depositAmount depositSubmittedAt depositRejectionReason pendingDepositType');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const settings = await Settings.getSettings();

    res.json({
        depositStatus: user.depositStatus,
        depositAmount: user.depositAmount || settings.depositAmount,
        requiredAmount: settings.depositAmount,
        depositSubmittedAt: user.depositSubmittedAt,
        rejectionReason: user.depositRejectionReason,
        pendingDepositType: user.pendingDepositType,
    });
}));

module.exports = router;
