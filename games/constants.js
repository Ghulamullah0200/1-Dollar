'use strict';

/**
 * Canonical list of all supported game names.
 *
 * Rules:
 *   - Only games whose GameSettings.isActive === true are joinable / subscribable.
 *   - Adding a game here expands enum validation; it does NOT auto-activate the game.
 *   - Carrom and Ludo are seeded with isActive: false (coming soon).
 */
const SUPPORTED_GAMES = ['flappy-bird', 'fruit-ninja', 'carrom', 'ludo'];

module.exports = { SUPPORTED_GAMES };
