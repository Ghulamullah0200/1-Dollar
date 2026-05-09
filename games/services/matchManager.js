/**
 * Match Manager — Match lifecycle, score submission, finalization
 */
const GameMatch = require('../models/GameMatch');
const GameSession = require('../models/GameSession');
const GameQueue = require('../models/GameQueue');
const PlayerStats = require('../models/PlayerStats');
const RewardEngine = require('./rewardEngine');
const logger = require('../../utils/logger');

class MatchManager {
    /**
     * Submit score for a match
     */
    static async submitScore(userId, matchId, score, duration, scoreHash = '', deviceInfo = {}) {
        const match = await GameMatch.findById(matchId);
        if (!match) throw new Error('Match not found');
        if (match.status === 'completed') throw new Error('Match already completed');
        if (match.status === 'cancelled') throw new Error('Match was cancelled');

        // Find the player in the match
        const player = match.players.find(p => p.userId.toString() === userId.toString());
        if (!player) throw new Error('You are not part of this match');
        if (player.hasPlayed) throw new Error('You have already submitted your score');

        // Validate score against cap
        const maxCap = match.settings.matchDurationSeconds ? match.settings.matchDurationSeconds * 100 : 999999;
        if (score < 0 || score > maxCap) {
            throw new Error('Invalid score detected');
        }

        // Record score
        player.score = score;
        player.finishedAt = new Date();
        player.hasPlayed = true;

        // Create session record
        await GameSession.create({
            userId,
            matchId,
            gameName: match.gameName,
            score,
            duration,
            startedAt: new Date(Date.now() - duration),
            endedAt: new Date(),
            deviceInfo,
            scoreHash
        });

        await match.save();

        logger.info('MATCH', `${player.username} submitted score ${score} for match ${matchId}`);

        // Check if all players finished
        if (match.allPlayersFinished()) {
            return await this.finalizeMatch(matchId);
        }

        return {
            status: 'score_recorded',
            match: match.toObject(),
            allFinished: false
        };
    }

    /**
     * Finalize match — determine winner, distribute rewards
     */
    static async finalizeMatch(matchId) {
        const match = await GameMatch.findById(matchId);
        if (!match) throw new Error('Match not found');
        if (match.status === 'completed') return { status: 'already_completed', match };

        // Determine winner
        const winner = match.determineWinner();
        if (winner) {
            match.winnerId = winner.userId;
            match.winnerUsername = winner.username;
        }

        match.status = 'completed';
        match.completedAt = new Date();
        await match.save();

        // Distribute reward
        let rewardResult = null;
        if (winner) {
            rewardResult = await RewardEngine.distributeReward(match);
        }

        // Update all players' stats
        for (const player of match.players) {
            const isWinner = winner && player.userId.toString() === winner.userId.toString();
            await PlayerStats.recordResult(
                player.userId,
                player.username,
                match.gameName,
                {
                    score: player.score,
                    won: isWinner,
                    earnings: isWinner ? match.winnerPrize : 0,
                    entryFee: match.entryFee
                }
            );

            // Update queue entries
            await GameQueue.updateMany(
                { userId: player.userId, matchId: match._id },
                { status: 'completed' }
            );
        }

        logger.info('MATCH', `Match ${matchId} finalized. Winner: ${match.winnerUsername || 'none'}, Prize: $${match.winnerPrize}`);

        return {
            status: 'completed',
            match: match.toObject(),
            winner: winner ? {
                userId: winner.userId,
                username: winner.username,
                score: winner.score,
                prize: match.winnerPrize
            } : null,
            rewardResult
        };
    }

    /**
     * Force-finalize timed-out matches
     */
    static async finalizeTimedOutMatches() {
        const timedOut = await GameMatch.find({
            status: 'active',
            timeoutAt: { $lte: new Date() }
        });

        const results = [];
        for (const match of timedOut) {
            try {
                const result = await this.finalizeMatch(match._id);
                results.push(result);
            } catch (err) {
                logger.error('MATCH', `Failed to finalize timed-out match ${match._id}: ${err.message}`);
            }
        }

        if (results.length > 0) {
            logger.info('MATCH', `Force-finalized ${results.length} timed-out matches`);
        }

        return results;
    }

    /**
     * Get match status
     */
    static async getMatchStatus(matchId) {
        const match = await GameMatch.findById(matchId).lean();
        if (!match) throw new Error('Match not found');

        return {
            ...match,
            playersFinished: match.players.filter(p => p.hasPlayed).length,
            playersTotal: match.players.length,
            allFinished: match.players.every(p => p.hasPlayed)
        };
    }

    /**
     * Get user's active match
     */
    static async getActiveMatch(userId) {
        return GameMatch.getActiveForUser(userId);
    }

    /**
     * Get match history
     */
    static async getMatchHistory(userId, limit = 20, skip = 0) {
        return GameMatch.getUserHistory(userId, limit, skip);
    }

    /**
     * Cancel a match (admin only)
     */
    static async cancelMatch(matchId) {
        const match = await GameMatch.findById(matchId);
        if (!match) throw new Error('Match not found');
        if (match.status === 'completed') throw new Error('Cannot cancel completed match');

        // Refund all players
        for (const player of match.players) {
            await require('../../models/User').findByIdAndUpdate(player.userId, {
                $inc: { 'wallet.balance': match.entryFee }
            });
        }

        match.status = 'cancelled';
        match.completedAt = new Date();
        await match.save();

        // Update queue entries
        await GameQueue.updateMany(
            { matchId: match._id },
            { status: 'cancelled' }
        );

        logger.info('MATCH', `Match ${matchId} cancelled. All ${match.players.length} players refunded $${match.entryFee}`);

        return match;
    }
}

module.exports = MatchManager;
