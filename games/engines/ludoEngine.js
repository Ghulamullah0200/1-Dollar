'use strict';

/**
 * ludoEngine.js — Server-authoritative 2-player Ludo engine
 *
 * Board layout (canonical 2-player, Red vs Blue):
 *   Path has 52 main squares (0–51), numbered clockwise.
 *   Each color has 5 home-column squares (positions 52–56) + finish (57).
 *
 * Token positions:
 *   -1      = Yard (not yet on board)
 *    0–51   = Shared main path (color-offset applied per player)
 *   52–56   = Home column (color-specific, only own tokens enter)
 *   57      = Finished
 *
 * Starting squares (where a token enters when 6 is rolled):
 *   Red:  path index 0  (main path square 0)
 *   Blue: path index 26 (main path square 26)
 *
 * Safe squares on main path (shared, 0-indexed): 0, 8, 13, 21, 26, 34, 39, 47
 * These match the star squares in standard Ludo boards.
 */

const crypto = require('crypto');

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAIN_PATH_LENGTH  = 52;   // squares 0–51 on the shared ring
const HOME_COL_LENGTH   = 5;    // squares 52–56 in home column
const FINISH_POS        = 57;   // token is done

// Starting main-path index for each color (where they enter after rolling 6)
const START_POS = { red: 0, blue: 26 };

// Safe squares on the main path (0-indexed) — tokens here cannot be captured
const SAFE_SQUARES = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// Main-path index at which each color turns into its home column
// Red:  enters home col after square 51  (coming from 50→51→52)
// Blue: enters home col after square 25  (coming from 24→25→26) — but blue's start is 26
//   In canonical terms: blue turns into home after reaching square 25 in its own path.
// Easiest to track progress as "steps from start".
// Steps to reach home column entry from start: 50 steps on main path, then 5+1 home.

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute the absolute board position after `steps` steps from start.
 * Returns -1 if still in yard.
 * `step` = 0 means just entered (at start square).
 */
function stepsToPos(color, steps) {
    if (steps < 0) return -1;   // still in yard
    if (steps <= MAIN_PATH_LENGTH - 1) {
        // On the main ring
        const start = START_POS[color];
        return (start + steps) % MAIN_PATH_LENGTH;
    }
    // In home column or finished
    const homeStep = steps - MAIN_PATH_LENGTH;   // 0=first home col square
    if (homeStep < HOME_COL_LENGTH) {
        return 52 + homeStep;   // home column squares 52-56
    }
    return FINISH_POS;   // 57 = finished
}

/**
 * Get steps-from-start for a token.
 * Returns -1 if in yard.
 */
function getSteps(token) {
    return token.steps;
}

/**
 * True if a main-path position is safe for any token.
 */
function isSafeSquare(pos) {
    return pos < MAIN_PATH_LENGTH && SAFE_SQUARES.has(pos);
}

/**
 * True if a position is in the home column (exclusive to one color).
 */
function isHomeCol(pos) {
    return pos >= 52 && pos <= 56;
}

// ─── createInitialState ───────────────────────────────────────────────────────

/**
 * Build a fresh Ludo state for two players.
 *
 * @param {string} redId    userId of the Red player
 * @param {string} blueId   userId of the Blue player
 * @returns {object}        Initial state stored in GameRoom.state
 */
function createInitialState(redId, blueId) {
    const makeTokens = (color) =>
        [0, 1, 2, 3].map(i => ({
            id:     `${color[0]}${i}`,    // 'r0', 'r1', 'b0', 'b1' …
            color,
            steps:  -1,    // -1 = in yard
            pos:    -1,    // absolute board position (-1 = yard)
        }));

    return {
        version: 1,

        players: {
            red:  redId,
            blue: blueId,
        },

        tokens: {
            red:  makeTokens('red'),
            blue: makeTokens('blue'),
        },

        // Current turn
        currentTurnColor:  'red',        // red always goes first
        currentTurnUserId: redId,

        // Dice state
        dice:        null,       // value of last roll (1–6)
        diceRolled:  false,      // false = must roll; true = must move (or pass if no moves)

        // Extra turn flag
        extraTurnPending: false,

        // Result
        winner:   null,
        gameOver: false,

        // Debug / replay
        lastEvent: null,
    };
}

// ─── rollDice ─────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure dice roll (1–6).
 * Must only be called server-side.
 *
 * @returns {number}  1–6
 */
function rollDice() {
    return crypto.randomInt(1, 7);
}

// ─── getMovableTokens ────────────────────────────────────────────────────────

/**
 * Given a rolled dice value, return the list of token IDs the current player
 * can legally move.
 *
 * Rules:
 *  - Tokens in yard: only movable if dice === 6
 *  - Tokens on main path or home col: movable if move doesn't overshoot finish
 *  - Tokens already finished (steps === 56): not movable
 *
 * @param {object} state
 * @param {string} userId
 * @returns {string[]}  Array of movable token IDs
 */
function getMovableTokens(state, userId) {
    if (!state.diceRolled || state.gameOver) return [];

    const color  = state.currentTurnColor;
    if (state.players[color] !== userId) return [];

    const tokens = state.tokens[color];
    const dice   = state.dice;
    const movable = [];

    for (const token of tokens) {
        if (token.steps === 56) continue;   // already finished (pos=57 after step 56)

        if (token.steps === -1) {
            // In yard — can only move on 6
            if (dice === 6) movable.push(token.id);
        } else {
            // On board — can move if won't overshoot finish
            const newSteps = token.steps + dice;
            if (newSteps <= 56) {
                movable.push(token.id);
            }
        }
    }

    return movable;
}

// ─── validateMove ────────────────────────────────────────────────────────────

/**
 * Validate that a token move is legal.
 *
 * @param {object} state
 * @param {string} userId
 * @param {string} tokenId
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateMove(state, userId, tokenId) {
    if (!state)          return { valid: false, reason: 'No active game state.' };
    if (state.gameOver)  return { valid: false, reason: 'Game is already over.' };

    const color = state.currentTurnColor;
    if (state.players[color] !== userId) {
        return { valid: false, reason: 'Not your turn.' };
    }

    if (!state.diceRolled) {
        return { valid: false, reason: 'You must roll the dice first.' };
    }

    const movable = getMovableTokens(state, userId);
    if (!movable.includes(tokenId)) {
        return { valid: false, reason: 'That token cannot move with the current dice value.' };
    }

    return { valid: true };
}

// ─── applyMove ───────────────────────────────────────────────────────────────

/**
 * Apply a validated token move and return the new state.
 * Input state is NOT mutated (deep clone performed internally).
 *
 * Handles:
 *  - Yard exit (steps -1 → 0 when dice = 6)
 *  - Main path movement
 *  - Home column entry
 *  - Token finish
 *  - Capture of opponent tokens (if landing on non-safe non-home square)
 *  - Extra turn on 6 or on capture
 *  - Auto-pass when no moves available after roll
 *  - Win detection
 *
 * @param {object} state
 * @param {string} userId
 * @param {string} tokenId
 * @returns {object}   New state
 */
function applyMove(state, userId, tokenId) {
    const newState = JSON.parse(JSON.stringify(state));

    const color    = newState.currentTurnColor;
    const oppColor = color === 'red' ? 'blue' : 'red';
    const dice     = newState.dice;

    // ── Find and advance the token ─────────────────────────────────────────
    const tokens = newState.tokens[color];
    const token  = tokens.find(t => t.id === tokenId);

    const prevSteps = token.steps;
    const newSteps  = prevSteps === -1 ? 0 : prevSteps + dice;
    token.steps     = newSteps;
    token.pos       = stepsToPos(color, newSteps);

    // ── Capture logic ──────────────────────────────────────────────────────
    let captured = false;
    if (token.pos >= 0 && token.pos < MAIN_PATH_LENGTH && !isSafeSquare(token.pos)) {
        // Check if any opponent token is on the same main-path square
        const oppTokens = newState.tokens[oppColor];
        for (const opp of oppTokens) {
            if (opp.pos === token.pos && opp.steps >= 0 && opp.steps < MAIN_PATH_LENGTH) {
                // Capture — send opponent back to yard
                opp.steps = -1;
                opp.pos   = -1;
                captured  = true;
            }
        }
    }

    // ── Determine next turn ────────────────────────────────────────────────
    // Extra turn if: rolled 6 OR captured an opponent
    const extraTurn = (dice === 6 || captured);

    // ── Win check ─────────────────────────────────────────────────────────
    const allFinished = tokens.every(t => t.steps === 56);
    if (allFinished) {
        newState.gameOver         = true;
        newState.winner           = color;
        newState.currentTurnColor  = null;
        newState.currentTurnUserId = null;
    } else if (extraTurn) {
        // Same player goes again — reset dice state for new roll
        newState.diceRolled = false;
        newState.dice       = null;
    } else {
        // Switch turns
        newState.currentTurnColor  = oppColor;
        newState.currentTurnUserId = newState.players[oppColor];
        newState.diceRolled        = false;
        newState.dice              = null;
    }

    newState.version += 1;
    newState.lastEvent = {
        type:      'move',
        userId,
        tokenId,
        fromSteps: prevSteps,
        toSteps:   newSteps,
        toPos:     token.pos,
        dice,
        captured,
        extraTurn,
    };

    return newState;
}

/**
 * Apply a dice roll to the state.
 * Returns the new state with `dice` set and `diceRolled = true`.
 * If no tokens can move, auto-passes the turn.
 *
 * @param {object} state
 * @param {string} userId
 * @param {number} diceValue   Pre-generated by rollDice()
 * @returns {{ newState: object, movableTokens: string[], autoPassed: boolean }}
 */
function applyRoll(state, userId, diceValue) {
    const newState = JSON.parse(JSON.stringify(state));

    newState.dice       = diceValue;
    newState.diceRolled = true;
    newState.version   += 1;
    newState.lastEvent  = { type: 'dice_roll', userId, diceValue };

    // Compute movable tokens in the new state
    const movable = getMovableTokens(newState, userId);

    let autoPassed = false;
    if (movable.length === 0) {
        // No valid moves — auto-pass turn (unless it's a 6, which gives another roll)
        if (diceValue === 6) {
            // Can't move any token but rolled 6 — all tokens either in yard or blocked.
            // In standard Ludo, another roll would be given; here we just pass for simplicity.
            // (Edge case: all tokens finished — shouldn't occur as game ends first)
        }
        // Pass turn to opponent
        const color    = newState.currentTurnColor;
        const oppColor = color === 'red' ? 'blue' : 'red';
        newState.currentTurnColor  = oppColor;
        newState.currentTurnUserId = newState.players[oppColor];
        newState.diceRolled        = false;
        newState.dice              = null;
        autoPassed = true;
    }

    return { newState, movableTokens: movable, autoPassed };
}

// ─── checkWin ────────────────────────────────────────────────────────────────

/**
 * @param {object} state
 * @returns {{ gameOver: boolean, winnerColor: string|null, winnerId: string|null }}
 */
function checkWin(state) {
    if (state && state.gameOver && state.winner) {
        return {
            gameOver:    true,
            winnerColor: state.winner,
            winnerId:    state.players[state.winner],
        };
    }
    return { gameOver: false, winnerColor: null, winnerId: null };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    createInitialState,
    rollDice,
    applyRoll,
    validateMove,
    applyMove,
    getMovableTokens,
    checkWin,
    // Expose constants for client reference
    MAIN_PATH_LENGTH,
    FINISH_POS,
    SAFE_SQUARES: [...SAFE_SQUARES],
    START_POS,
};
