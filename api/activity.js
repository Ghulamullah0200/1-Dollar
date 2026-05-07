const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const { asyncHandler } = require('../utils/helpers');

// ═══════════════════════════════════════════════════
// PUBLIC: Live Activity Feed
// ═══════════════════════════════════════════════════
router.get('/live-feed', asyncHandler(async (req, res) => {
    // Get latest completed transactions for transparency
    const transactions = await Transaction.find({ status: 'completed' })
        .select('userId type amount createdAt description')
        .populate('userId', 'username')
        .sort({ createdAt: -1 })
        .limit(30)
        .lean();

    // Format for common feed
    const activity = transactions.map(t => ({
        id: t._id,
        user: t.userId?.username || 'User',
        type: t.type === 'signup_bonus' ? 'Signup'
            : t.type === 'withdrawal' ? 'Withdrawal'
                : t.type === 'referral_bonus' ? 'Reward'
                    : 'Activity',
        amount: t.amount,
        date: t.createdAt,
        icon: t.type === 'signup_bonus' ? '🚀'
            : t.type === 'withdrawal' ? '💰'
                : '🤝'
    }));

    res.json({ activity });
}));

module.exports = router;
