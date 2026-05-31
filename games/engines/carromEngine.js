'use strict';

/**
 * carromEngine.js — Server-authoritative Carrom game engine (Phase 2 MVP)
 *
 * Board coordinate system:
 *   Origin (0,0) = top-left corner
 *   X increases right, Y increases down
 *   Logical board size: 600×600 units
 *   Inner playing area: x:[45,555], y:[45,555]  (45-unit border each side)
 *
 * Player convention (free practice / bot mode):
 *   Human player  → color 'white', shoots from bottom baseline (y ≈ 545)
 *   Bot player    → color 'black', shoots from top    baseline (y ≈ 55)
 *   Bot playerId  → the literal string 'bot'
 *
 * TODO: Replace simplified step-simulation physics with a Matter.js
 *       rigid-body world for Phase 3+ accuracy (continuous collision detection,
 *       proper restitution coefficients, rolling friction, etc.)
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const BOARD = {
    SIZE:    600,
    PADDING: 45,   // border width; inner area spans [PADDING, SIZE-PADDING]
};

const PUCK = {
    RADIUS: 14,
};

const STRIKER = {
    RADIUS: 18,
};

/** Pocket capture circles — puck is pocketed when its centre lands within RADIUS. */
const POCKET = {
    RADIUS: 28,
    POSITIONS: [
        { x: 45,  y: 45  },   // top-left
        { x: 555, y: 45  },   // top-right
        { x: 555, y: 555 },   // bottom-right
        { x: 45,  y: 555 },   // bottom-left
    ],
};

const PHYSICS = {
    FRICTION:    0.984,   // velocity multiplier per tick (linear decay)
    RESTITUTION: 0.82,    // elasticity of circle-circle / circle-wall collisions
    MIN_SPEED:   0.06,    // velocity magnitude below which an entity is treated as stopped
    MAX_TICKS:   3000,    // safety ceiling; prevents infinite loop if friction is mis-tuned
    TICK_DT:     0.5,     // time-step per physics tick (logical units)
    MAX_POWER:   100,
};

/** Striker baseline Y for each side. */
const BASELINE = {
    BOTTOM: BOARD.SIZE - BOARD.PADDING - STRIKER.RADIUS - 4,  // 533 — human
    TOP:    BOARD.PADDING + STRIKER.RADIUS + 4,                // 67  — bot
};

/** Striker X limits (same for both sides). */
const STRIKER_X = {
    MIN: BOARD.PADDING + STRIKER.RADIUS + 4,                   // 67
    MAX: BOARD.SIZE - BOARD.PADDING - STRIKER.RADIUS - 4,      // 533
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

function dist2d(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/** Returns true if the entity centre has fallen inside any pocket circle. */
function _isInPocket(entity) {
    for (const p of POCKET.POSITIONS) {
        if (dist2d(entity, p) <= POCKET.RADIUS) return true;
    }
    return false;
}

/**
 * Resolve an elastic circle-circle collision.
 * Assumes equal mass; modifies velocities in-place.
 */
function _resolveCollision(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d  = Math.sqrt(dx * dx + dy * dy);
    if (d === 0) return;

    const nx = dx / d;
    const ny = dy / d;

    const dvn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (dvn <= 0) return;   // already separating

    const impulse = dvn * PHYSICS.RESTITUTION;
    a.vx -= impulse * nx;
    a.vy -= impulse * ny;
    b.vx += impulse * nx;
    b.vy += impulse * ny;
}

/** Bounce an entity off the inner wall boundary; modifies position and velocity. */
function _bounceWalls(entity, radius) {
    const lo = BOARD.PADDING + radius;
    const hi = BOARD.SIZE - BOARD.PADDING - radius;

    if (entity.x < lo) { entity.x = lo; entity.vx =  Math.abs(entity.vx) * PHYSICS.RESTITUTION; }
    if (entity.x > hi) { entity.x = hi; entity.vx = -Math.abs(entity.vx) * PHYSICS.RESTITUTION; }
    if (entity.y < lo) { entity.y = lo; entity.vy =  Math.abs(entity.vy) * PHYSICS.RESTITUTION; }
    if (entity.y > hi) { entity.y = hi; entity.vy = -Math.abs(entity.vy) * PHYSICS.RESTITUTION; }
}

/**
 * Step-simulate the full shot until all entities stop or MAX_TICKS is reached.
 *
 * @param {object[]} entities   Mutable array of entity objects
 *                              Each has: { id, isStriker?, x, y, vx, vy, pocketed }
 * @returns {{ pocketedIds: string[], strikerPocketed: boolean }}
 */
function _runPhysics(entities) {
    const pocketedThisShot = [];
    let   strikerPocketed  = false;

    for (let tick = 0; tick < PHYSICS.MAX_TICKS; tick++) {
        let anyMoving = false;

        // 1. Integrate + friction + walls + pocket check
        for (const e of entities) {
            if (e.pocketed) continue;

            e.x += e.vx * PHYSICS.TICK_DT;
            e.y += e.vy * PHYSICS.TICK_DT;
            e.vx *= PHYSICS.FRICTION;
            e.vy *= PHYSICS.FRICTION;

            const speed = Math.sqrt(e.vx * e.vx + e.vy * e.vy);
            if (speed < PHYSICS.MIN_SPEED) {
                e.vx = 0;
                e.vy = 0;
            } else {
                anyMoving = true;
            }

            const r = e.isStriker ? STRIKER.RADIUS : PUCK.RADIUS;
            _bounceWalls(e, r);

            if (e.isStriker) {
                if (_isInPocket(e)) {
                    strikerPocketed = true;
                    e.pocketed = true;
                    e.vx = 0; e.vy = 0;
                }
            } else {
                if (_isInPocket(e)) {
                    e.pocketed = true;
                    pocketedThisShot.push(e.id);
                    e.vx = 0; e.vy = 0;
                }
            }
        }

        // 2. Pairwise collision resolution — O(n²), acceptable for ≤21 entities
        const active = entities.filter(e => !e.pocketed);
        for (let i = 0; i < active.length; i++) {
            for (let j = i + 1; j < active.length; j++) {
                const a  = active[i];
                const b  = active[j];
                const ra = a.isStriker ? STRIKER.RADIUS : PUCK.RADIUS;
                const rb = b.isStriker ? STRIKER.RADIUS : PUCK.RADIUS;
                const minDist = ra + rb;

                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d  = Math.sqrt(dx * dx + dy * dy);

                if (d < minDist && d > 0) {
                    // Positional correction (push apart)
                    const overlap = (minDist - d) / 2;
                    const nx = dx / d;
                    const ny = dy / d;
                    a.x -= nx * overlap;
                    a.y -= ny * overlap;
                    b.x += nx * overlap;
                    b.y += ny * overlap;

                    _resolveCollision(a, b);
                }
            }
        }

        if (!anyMoving) break;
    }

    return { pocketedIds: pocketedThisShot, strikerPocketed };
}

// ─── createInitialState ───────────────────────────────────────────────────────

/**
 * Build the full initial board state for a new Carrom match.
 *
 * Puck arrangement (standard):
 *   Queen          — 1 red puck at board centre (300, 300)
 *   Inner ring     — 6 pucks (3 white + 3 black, alternating) at radius 35
 *   Outer ring     — 12 pucks (6 white + 6 black, alternating) at radius 70
 *   Total          — 1 + 6 + 12 = 19  (9 white, 9 black, 1 queen)
 *
 * @param {string} humanPlayerId   Actual userId string of the human player
 * @param {string} [botPlayerId]   Always 'bot' for free-practice mode
 * @returns {object}               Initial state object stored in GameRoom.state
 */
function createInitialState(humanPlayerId, botPlayerId = 'bot') {
    const cx = BOARD.SIZE / 2;   // 300
    const cy = BOARD.SIZE / 2;   // 300

    const pucks = [];

    // Queen at centre
    pucks.push({
        id: 'queen', type: 'queen',
        x: cx, y: cy, vx: 0, vy: 0, pocketed: false,
    });

    // Inner ring: 6 pucks at radius 35, starting angle 0, alternating white/black
    const R1 = 35;
    for (let i = 0; i < 6; i++) {
        const angle  = (i / 6) * Math.PI * 2;
        const isWhite = (i % 2 === 0);
        const idx    = Math.floor(i / 2) + 1;          // 1, 2, 3 per colour
        pucks.push({
            id: `${isWhite ? 'w' : 'b'}${idx}`,
            type: isWhite ? 'white' : 'black',
            x: cx + Math.cos(angle) * R1,
            y: cy + Math.sin(angle) * R1,
            vx: 0, vy: 0, pocketed: false,
        });
    }

    // Outer ring: 12 pucks at radius 70, half-step offset, alternating white/black
    const R2 = 70;
    for (let i = 0; i < 12; i++) {
        const angle   = ((i / 12) * Math.PI * 2) + (Math.PI / 12);
        const isWhite = (i % 2 === 0);
        const idx     = Math.floor(i / 2) + 4;         // 4..9 per colour
        pucks.push({
            id: `${isWhite ? 'w' : 'b'}${idx}`,
            type: isWhite ? 'white' : 'black',
            x: cx + Math.cos(angle) * R2,
            y: cy + Math.sin(angle) * R2,
            vx: 0, vy: 0, pocketed: false,
        });
    }

    return {
        version:   1,
        board:     { size: BOARD.SIZE, padding: BOARD.PADDING },
        pucks,

        // Human → white;  bot → black  (TODO Phase 3: coin-toss colour assignment)
        playerColors: {
            [humanPlayerId]: 'white',
            [botPlayerId]:   'black',
        },

        scores: {
            [humanPlayerId]: 0,
            [botPlayerId]:   0,
        },

        currentTurnPlayerId: humanPlayerId,  // human always has first move

        // Queen state — simplified for MVP (auto-covered; no separate cover turn)
        queenPocketed:  false,
        queenCoveredBy: null,
        // TODO Phase 3: Implement full queen cover rule:
        //   queenCoverRequired = true after queen is pocketed,
        //   pocketing player must sink one own-colour puck on the same/next turn.

        winner:        null,
        gameOver:      false,
        lastShotResult: null,
    };
}

// ─── validateShot ─────────────────────────────────────────────────────────────

/**
 * Validate a shot payload before simulation.
 *
 * @param {object} state
 * @param {string} playerId
 * @param {{ angle: number, power: number, strikerX: number }} shot
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateShot(state, playerId, shot) {
    if (!state)          return { valid: false, reason: 'No active game state.' };
    if (state.gameOver)  return { valid: false, reason: 'Game is already over.' };

    if (state.currentTurnPlayerId !== playerId) {
        return { valid: false, reason: 'Not your turn.' };
    }

    const { angle, power, strikerX } = shot || {};

    if (typeof angle !== 'number' || !isFinite(angle) || angle < 0 || angle > 360) {
        return { valid: false, reason: 'Invalid angle. Must be a number in [0, 360].' };
    }
    if (typeof power !== 'number' || !isFinite(power) || power <= 0 || power > PHYSICS.MAX_POWER) {
        return { valid: false, reason: `Invalid power. Must be in (0, ${PHYSICS.MAX_POWER}].` };
    }
    if (typeof strikerX !== 'number' || !isFinite(strikerX) ||
        strikerX < STRIKER_X.MIN || strikerX > STRIKER_X.MAX) {
        return {
            valid: false,
            reason: `Invalid strikerX. Must be in [${STRIKER_X.MIN}, ${STRIKER_X.MAX}].`,
        };
    }

    return { valid: true };
}

// ─── simulateShot ─────────────────────────────────────────────────────────────

/**
 * Apply a validated shot to the current state and return the new state.
 * The input state is NOT mutated (deep-clone is performed internally).
 *
 * @param {object} state     Current board state
 * @param {string} playerId  Player taking the shot (userId or 'bot')
 * @param {{ angle: number, power: number, strikerX: number }} shot
 * @returns {object}         New board state
 */
function simulateShot(state, playerId, shot) {
    const newState = JSON.parse(JSON.stringify(state));

    const { angle, power, strikerX } = shot;

    // Determine which baseline this player shoots from
    const playerColor = newState.playerColors[playerId];
    const strikerY    = (playerColor === 'white') ? BASELINE.BOTTOM : BASELINE.TOP;

    // Convert polar shot → initial velocity
    const angleRad = (angle * Math.PI) / 180;
    const speed    = (power / PHYSICS.MAX_POWER) * 22;   // max 22 units/tick
    const vx = Math.cos(angleRad) * speed;
    const vy = Math.sin(angleRad) * speed;

    // Build flat entity list: active (non-pocketed) pucks + striker
    const entities = newState.pucks
        .filter(p => !p.pocketed)
        .map(p => ({ ...p }));

    const striker = {
        id: 'striker', isStriker: true,
        x: strikerX, y: strikerY,
        vx, vy, pocketed: false,
    };
    entities.push(striker);

    // Run physics
    const { pocketedIds, strikerPocketed } = _runPhysics(entities);

    // Write back positions from simulation
    for (const e of entities) {
        if (e.isStriker) continue;
        const puck = newState.pucks.find(p => p.id === e.id);
        if (puck) {
            puck.x        = e.x;
            puck.y        = e.y;
            puck.vx       = e.vx;
            puck.vy       = e.vy;
            puck.pocketed = e.pocketed;
        }
    }

    // ── Classify pocketed pucks ─────────────────────────────────────────────
    const queenPocketedThisShot = pocketedIds.includes('queen');
    const whitePocketed = pocketedIds.filter(id => {
        const p = newState.pucks.find(pk => pk.id === id);
        return p && p.type === 'white';
    });
    const blackPocketed = pocketedIds.filter(id => {
        const p = newState.pucks.find(pk => pk.id === id);
        return p && p.type === 'black';
    });

    const opponentId   = Object.keys(newState.playerColors).find(k => k !== playerId);
    const ownColor     = newState.playerColors[playerId];
    const ownPocketed  = ownColor === 'white' ? whitePocketed : blackPocketed;
    const oppPocketed  = ownColor === 'white' ? blackPocketed : whitePocketed;

    // ── Foul detection ──────────────────────────────────────────────────────
    // A foul occurs when the striker is pocketed.
    // TODO Phase 3: additional fouls (board off, pocketing opponent's last puck, etc.)
    const isFoul = strikerPocketed;

    // ── Queen state ─────────────────────────────────────────────────────────
    // Simplified MVP: queen is auto-covered as soon as it is pocketed.
    // TODO Phase 3: queenCoverRequired flag — pocketing player must sink
    //              one own-colour puck on the same shot to "cover" the queen;
    //              otherwise queen is returned to the centre spot.
    if (queenPocketedThisShot && !newState.queenPocketed) {
        newState.queenPocketed  = true;
        newState.queenCoveredBy = playerId;   // simplified: immediately covered
    }

    // ── Score update ────────────────────────────────────────────────────────
    let nextTurn = opponentId;   // default: turn passes to opponent

    if (!isFoul) {
        newState.scores[playerId]   += ownPocketed.length;
        newState.scores[opponentId] += oppPocketed.length;

        // If the shooter pocketed at least one of their own pucks → same turn again
        if (ownPocketed.length > 0) {
            nextTurn = playerId;
        }
    }
    // Foul: no score change; turn passes to opponent automatically.
    // TODO Phase 3: proper foul penalty (un-pocket one already-scored puck).

    // ── Win check ───────────────────────────────────────────────────────────
    // MVP rule: first player whose assigned-colour pucks are all pocketed wins.
    // TODO Phase 3: win requires the queen to have been covered first.
    const whitePucksLeft = newState.pucks.filter(p => p.type === 'white' && !p.pocketed).length;
    const blackPucksLeft = newState.pucks.filter(p => p.type === 'black' && !p.pocketed).length;

    const humanPlayerId = Object.keys(newState.playerColors)
        .find(k => newState.playerColors[k] === 'white');
    const botPlayerId = Object.keys(newState.playerColors)
        .find(k => newState.playerColors[k] === 'black');

    if (whitePucksLeft === 0) {
        newState.winner  = humanPlayerId;
        newState.gameOver = true;
    } else if (blackPucksLeft === 0) {
        newState.winner  = botPlayerId;
        newState.gameOver = true;
    }

    // ── Advance state ───────────────────────────────────────────────────────
    newState.version             += 1;
    newState.currentTurnPlayerId  = newState.gameOver ? null : nextTurn;

    newState.lastShotResult = {
        playerId,
        shot,
        pocketedIds,
        ownPocketed,
        oppPocketed,
        queenPocketedThisShot,
        strikerPocketed,
        isFoul,
        whitePucksLeft,
        blackPucksLeft,
        nextTurn: newState.currentTurnPlayerId,
    };

    return newState;
}

// ─── botPickShot ──────────────────────────────────────────────────────────────

/**
 * Choose a shot for the bot player.
 *
 * @param {object} state
 * @param {'easy'|'medium'|'hard'} [difficulty]
 * @returns {{ angle: number, power: number, strikerX: number }}
 */
function botPickShot(state, difficulty = 'easy') {
    // Bot shoots from top baseline
    const strikerY = BASELINE.TOP;
    const minX     = STRIKER_X.MIN;
    const maxX     = STRIKER_X.MAX;

    const targets = state.pucks.filter(p => p.type === 'black' && !p.pocketed);

    if (targets.length === 0) {
        // No own-colour targets remain — play a random shot (game should be ending anyway)
        return {
            angle:    Math.random() * 360,
            power:    20 + Math.random() * 30,
            strikerX: minX + Math.random() * (maxX - minX),
        };
    }

    if (difficulty === 'easy') {
        // 25 % of shots: intentional miss (completely off-target) to simulate beginner play
        if (Math.random() < 0.25) {
            return {
                angle:    Math.random() * 360,
                power:    8 + Math.random() * 25,
                strikerX: minX + Math.random() * (maxX - minX),
            };
        }
        // Remaining 75 %: aim roughly at a random target with large jitter
        const target   = targets[Math.floor(Math.random() * targets.length)];
        const strikerX = minX + Math.random() * (maxX - minX);
        const dx       = target.x - strikerX;
        const dy       = target.y - strikerY;
        const base     = Math.atan2(dy, dx) * (180 / Math.PI);
        const jitter   = (Math.random() - 0.5) * 60;  // ±30°
        return {
            angle:    ((base + jitter) + 720) % 360,
            power:    12 + Math.random() * 40,
            strikerX,
        };
    }

    if (difficulty === 'medium') {
        // Aim at the black puck that is closest to any pocket (good candidate to sink),
        // then aim roughly toward that puck with a moderate jitter.
        let target = targets[0];
        let closestPocketDist = Infinity;
        for (const t of targets) {
            for (const pocket of POCKET.POSITIONS) {
                const d = dist2d(t, pocket);
                if (d < closestPocketDist) { closestPocketDist = d; target = t; }
            }
        }
        const strikerX = Math.max(minX, Math.min(maxX, target.x));
        const dx  = target.x - strikerX;
        const dy  = target.y - strikerY;
        const base = Math.atan2(dy, dx) * (180 / Math.PI);
        const jitter = (Math.random() - 0.5) * 30;   // ±15°
        return {
            angle:    ((base + jitter) + 720) % 360,
            power:    30 + Math.random() * 45,
            strikerX,
        };
    }

    // hard — aim at the target closest to any pocket
    let best      = targets[0];
    let bestScore = Infinity;
    for (const t of targets) {
        for (const pocket of POCKET.POSITIONS) {
            const d = dist2d(t, pocket);
            if (d < bestScore) { bestScore = d; best = t; }
        }
    }
    const strikerX = Math.max(minX, Math.min(maxX, best.x));
    const dx   = best.x - strikerX;
    const dy   = best.y - strikerY;
    const base = Math.atan2(dy, dx) * (180 / Math.PI);
    const jitter = (Math.random() - 0.5) * 12;   // ±6°
    return {
        angle:    ((base + jitter) + 720) % 360,
        power:    50 + Math.random() * 40,
        strikerX,
    };
}

// ─── checkWin ─────────────────────────────────────────────────────────────────

/**
 * @param {object} state
 * @returns {{ gameOver: boolean, winnerId: string|null }}
 */
function checkWin(state) {
    if (state && state.gameOver) {
        return { gameOver: true, winnerId: state.winner };
    }
    return { gameOver: false, winnerId: null };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    createInitialState,
    validateShot,
    simulateShot,
    botPickShot,
    checkWin,
    // Expose constants so clients / socket handlers can reference them
    BOARD,
    PUCK,
    STRIKER,
    POCKET,
    STRIKER_X,
    BASELINE,
};
