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
    const { proof } = req.body; // base64 image of payment screenshot

    if (!proof) {
        return res.status(400).json({ message: 'Payment proof screenshot is required' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.depositStatus === 'verified') {
        return res.status(400).json({ message: 'Your deposit has already been verified' });
    }

    if (user.depositStatus === 'pending') {
        return res.status(400).json({ message: 'You already have a pending deposit. Please wait for admin verification.' });
    }

    const settings = await Settings.getSettings();
    const amount = req.body.amount ? parseFloat(req.body.amount) : settings.depositAmount;

    user.depositStatus = 'pending';
    user.depositProof = proof;
    user.depositAmount = amount;
    user.depositSubmittedAt = new Date();
    user.depositRejectionReason = '';
    await user.save();

    // Create deposit transaction
    await new Transaction({
        userId: user._id,
        type: 'deposit',
        amount: amount,
        status: 'pending',
        description: `Deposit of $${amount.toFixed(2)} submitted for verification`
    }).save();

    // Admin alert
    if (req.io) {
        req.io.emit('admin:newDeposit', {
            title: '💵 New Deposit Submitted',
            body: `${user.username} submitted a $${amount.toFixed(2)} deposit for verification`,
            username: user.username,
            userId: user._id,
            amount: amount,
            timestamp: new Date().toISOString()
        });
    }
     // PUSH NOTIFICATION FOR ADMINS
    notificationService.sendToAdmins(
        '💵 New Deposit Submitted',
        `${user.username} submitted a $${amount.toFixed(2)} deposit for verification`,
        { type: 'new_deposit', userId: user._id.toString() }
    ).catch(err => logger.error('DEPOSIT_PUSH', err.message));
    
    logger.info('DEPOSIT', `User ${user.username} submitted deposit of $${amount.toFixed(2)}`);

    res.json({
        message: 'Deposit submitted! Please wait for admin verification.',
        depositStatus: 'pending',
        depositAmount: amount
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

    if (user.depositStatus === 'verified') {
        return res.status(400).json({ message: 'Your deposit has already been verified' });
    }

    if (user.depositStatus !== 'rejected') {
        return res.status(400).json({ message: 'You can only resubmit after a rejection' });
    }

    const settings = await Settings.getSettings();
    const amount = req.body.amount ? parseFloat(req.body.amount) : (user.depositAmount || settings.depositAmount);

    user.depositStatus = 'pending';
    user.depositProof = proof;
    user.depositAmount = amount;
    user.depositSubmittedAt = new Date();
    user.depositRejectionReason = '';
    await user.save();

    await new Transaction({
        userId: user._id,
        type: 'deposit',
        amount: amount,
        status: 'pending',
        description: `Deposit resubmitted for $${amount.toFixed(2)}`
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
    const user = await User.findById(req.userId).select('depositStatus depositAmount depositSubmittedAt depositRejectionReason');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const settings = await Settings.getSettings();

    res.json({
        depositStatus: user.depositStatus,
        depositAmount: user.depositAmount || settings.depositAmount,
        requiredAmount: settings.depositAmount,
        depositSubmittedAt: user.depositSubmittedAt,
        rejectionReason: user.depositRejectionReason,
    });
}));

module.exports = router;
