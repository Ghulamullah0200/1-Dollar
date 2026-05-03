const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const Withdrawal = require('../models/Withdrawal');
const { asyncHandler } = require('../utils/helpers');

// ═══════════════════════════════════════════════════
// PUBLIC: Live Activity Feed
// ═══════════════════════════════════════════════════
router.get('/live-feed', asyncHandler(async (req, res) => {
    // Get latest transactions and withdrawals for transparency
    const [transactions, withdrawals] = await Promise.all([
        Transaction.find({ status: 'completed' })
            .select('userId type amount createdAt description')
            .populate('userId', 'username')
            .sort({ createdAt: -1 })
            .limit(20)
            .lean(),
        Withdrawal.find({ status: 'completed' })
            .select('userId amount createdAt')
            .populate('userId', 'username')
            .sort({ createdAt: -1 })
            .limit(20)
            .lean()
    ]);

    // Format for common feed
    const activity = [
        ...transactions.map(t => ({
            id: t._id,
            user: t.userId?.username || 'User',
            type: t.type === 'signup_bonus' ? 'Signup' : 'Reward',
            amount: t.amount,
            date: t.createdAt,
            icon: t.type === 'signup_bonus' ? '🚀' : '🤝'
        })),
        ...withdrawals.map(w => ({
            id: w._id,
            user: w.userId?.username || 'User',
            type: 'Withdrawal',
            amount: w.amount,
            date: w.createdAt,
            icon: '💰'
        }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 30);

    res.json({ activity });
}));

module.exports = router;
