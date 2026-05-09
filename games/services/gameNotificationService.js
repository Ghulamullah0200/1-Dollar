/**
 * Game Notification Service — Game-specific notification templates
 * Wraps the existing notificationService.js
 */
const notificationService = require('../../services/notificationService');
const logger = require('../../utils/logger');

class GameNotificationService {
    /**
     * Notify player they joined the queue
     */
    static async notifyQueueJoined(userId, gameName, position) {
        return notificationService.sendToUser(
            userId,
            '🎮 Queue Joined!',
            `You're #${position} in the ${this._formatGameName(gameName)} queue.`,
            { type: 'game_queue_joined', gameName }
        );
    }

    /**
     * Notify all players that a match was found
     */
    static async notifyMatchFound(playerIds, gameName, matchId) {
        const promises = playerIds.map(userId =>
            notificationService.sendToUser(
                userId,
                '⚔️ Match Found!',
                `Your ${this._formatGameName(gameName)} match is ready! Tap to play.`,
                { type: 'game_match_found', gameName, matchId: matchId.toString() }
            )
        );
        return Promise.allSettled(promises);
    }

    /**
     * Notify winner
     */
    static async notifyWinner(userId, gameName, prize) {
        return notificationService.sendToUser(
            userId,
            '🏆 You Won!',
            `Congratulations! You won $${prize.toFixed(2)} in ${this._formatGameName(gameName)}!`,
            { type: 'game_winner', gameName, prize: prize.toString() }
        );
    }

    /**
     * Notify non-winners about match result
     */
    static async notifyMatchResult(playerIds, gameName, winnerUsername, winnerId) {
        const promises = playerIds
            .filter(id => id.toString() !== winnerId.toString())
            .map(userId =>
                notificationService.sendToUser(
                    userId,
                    '🎮 Match Complete',
                    `${winnerUsername} won the ${this._formatGameName(gameName)} match. Better luck next time!`,
                    { type: 'game_match_result', gameName }
                )
            );
        return Promise.allSettled(promises);
    }

    /**
     * Notify reward credited to wallet
     */
    static async notifyRewardCredited(userId, amount) {
        return notificationService.sendToUser(
            userId,
            '💰 Reward Credited!',
            `$${amount.toFixed(2)} has been added to your wallet.`,
            { type: 'game_reward_credited', amount: amount.toString() }
        );
    }

    /**
     * Notify subscription expiry warning (3 days before)
     */
    static async notifySubscriptionExpiring(userId, gameName, daysLeft) {
        return notificationService.sendToUser(
            userId,
            '⏰ Subscription Expiring',
            `Your ${this._formatGameName(gameName)} subscription expires in ${daysLeft} days. Renew to keep playing!`,
            { type: 'game_sub_expiring', gameName, daysLeft: daysLeft.toString() }
        );
    }

    /**
     * Broadcast game availability
     */
    static async broadcastGameAvailable(gameName) {
        return notificationService.sendBroadcast(
            '🎮 Game Available!',
            `${this._formatGameName(gameName)} is now available. Join the queue and start playing!`,
            { type: 'game_available', gameName }
        );
    }

    /**
     * Format game name for display
     */
    static _formatGameName(gameName) {
        const names = {
            'flappy-bird': 'Flappy Bird',
            'fruit-ninja': 'Fruit Ninja'
        };
        return names[gameName] || gameName;
    }
}

module.exports = GameNotificationService;
