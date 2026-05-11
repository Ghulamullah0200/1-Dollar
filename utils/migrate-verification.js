/**
 * Migration: Backfill hasPaidVerificationFee for existing verified users
 * 
 * Run once after deploying the new schema:
 *   node utils/migrate-verification.js
 * 
 * This sets hasPaidVerificationFee = true for all users who currently
 * have depositStatus === 'verified', preserving their access.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function migrate() {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Find all currently verified users
    const result = await User.updateMany(
        { depositStatus: 'verified', hasPaidVerificationFee: { $ne: true } },
        {
            $set: {
                hasPaidVerificationFee: true,
                verificationApprovedAt: new Date(),
                // Reset depositStatus to 'none' so they can submit wallet top-ups
                depositStatus: 'none'
            }
        }
    );

    console.log(`✅ Migrated ${result.modifiedCount} users to hasPaidVerificationFee = true`);

    // Also handle users with depositStatus 'none' or 'rejected' who had previously been verified
    // (Check if they have a completed deposit/verification transaction)
    const Transaction = require('../models/Transaction');
    const usersWithCompletedDeposits = await Transaction.distinct('userId', {
        type: { $in: ['deposit', 'verification'] },
        status: 'completed'
    });

    if (usersWithCompletedDeposits.length > 0) {
        const extraResult = await User.updateMany(
            { _id: { $in: usersWithCompletedDeposits }, hasPaidVerificationFee: { $ne: true } },
            { $set: { hasPaidVerificationFee: true, verificationApprovedAt: new Date() } }
        );
        console.log(`✅ Migrated ${extraResult.modifiedCount} additional users from transaction history`);
    }

    await mongoose.disconnect();
    console.log('Done');
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
