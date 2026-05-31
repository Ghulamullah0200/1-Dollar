'use strict';

/**
 * carromSocket.js — Carrom-specific Socket.IO event handlers (Phase 2 MVP)
 *
 * Registered per-socket by gameSocket.js inside the /v2 namespace.
 *
 * Events handled:
 *   carrom:shot   — human player fires a shot
 *
 * Events emitted:
 *   carrom:state        — broadcast to match:<roomId> after every shot
 *   carrom:shot:rejected — sent only to the requesting socket on validation failure
 *   game:match:end      — broadcast to match:<roomId> when the game ends
 *   game:error          — sent to requesting socket on unexpected server error
 *
 * Free-practice guarantee:
 *   room.entryFee === 0 → no wallet deduction, no reward payout ever.
 *   game:match:end carries  isPractice:true  and  payout:0  so the client
 *   knows it should show a "practice over" screen and NOT poll for earnings.
 */

const logger       = require('../../utils/logger');
const GameRoom     = require('../models/GameRoom');
const GameMove     = require('../models/GameMove');
const carromEngine = require('../engines/carromEngine');
const RoomManager  = require('../services/roomManager');

/** Milliseconds the server waits before executing a bot shot (simulates "thinking"). */
const BOT_DELAY_MS = 900;

/**
 * Maximum number of consecutive bot-scored turns allowed per game.
 * Prevents an infinite scheduling loop if physics is degenerate and the bot
 * never stops pocketing its own pucks (should never happen in practice, but
 * this is a hard safety ceiling).
 */
const MAX_BOT_CHAIN = 15;

// ─── registerCarromHandlers ───────────────────────────────────────────────────

/**
 * Attach all Carrom socket handlers to a single authenticated socket.
 *
 * @param {import('socket.io').Socket}    socket
 * @param {import('socket.io').Namespace} v2      The /v2 namespace (for broadcasting)
 */
function registerCarromHandlers(socket, v2) {
    const userId = socket.userId;

    // ── carrom:shot ────────────────────────────────────────────────────────────
    // Payload: { roomId, angle, power, strikerX, stateVersion }
    socket.on('carrom:shot', async (payload) => {
        const shotStart = Date.now();

        try {
            const { roomId, angle, power, strikerX, stateVersion } = payload || {};

            // ── Basic presence check ──────────────────────────────────────────
            if (!roomId) {
                return socket.emit('carrom:shot:rejected', {
                    code: 'INVALID_PARAMS',
                    message: 'roomId is required.',
                });
            }

            // ── Load room ─────────────────────────────────────────────────────
            const room = await GameRoom.findById(roomId);
            if (!room) {
                return socket.emit('carrom:shot:rejected', {
                    code: 'ROOM_NOT_FOUND',
                    message: 'Room not found.',
                });
            }

            // ── Game/status guards ─────────────────────────────────────────────
            if (room.gameName !== 'carrom') {
                return socket.emit('carrom:shot:rejected', {
                    code: 'WRONG_GAME',
                    message: 'This is not a Carrom room.',
                });
            }
            if (room.status !== 'active') {
                return socket.emit('carrom:shot:rejected', {
                    code: 'ROOM_NOT_ACTIVE',
                    message: `Room is not active (status: ${room.status}).`,
                });
            }

            // ── Participant check ──────────────────────────────────────────────
            const isParticipant = room.players.some(
                p => p.userId && p.userId.toString() === userId
            );
            if (!isParticipant) {
                return socket.emit('carrom:shot:rejected', {
                    code: 'NOT_PARTICIPANT',
                    message: 'You are not a participant in this room.',
                });
            }

            // ── State version guard (prevents stale / replayed moves) ──────────
            // Coerce to Number so string-vs-number strict equality never false-fails.
            if (stateVersion !== undefined && stateVersion !== null &&
                room.stateVersion !== Number(stateVersion)) {
                return socket.emit('carrom:shot:rejected', {
                    code: 'STALE_STATE',
                    message: `State version mismatch. Expected ${room.stateVersion}, got ${stateVersion}.`,
                });
            }

            // ── Turn check ────────────────────────────────────────────────────
            if (!room.currentTurnUserId ||
                room.currentTurnUserId.toString() !== userId) {
                return socket.emit('carrom:shot:rejected', {
                    code: 'NOT_YOUR_TURN',
                    message: 'It is not your turn.',
                });
            }

            const currentState = room.state;
            const shot         = { angle, power, strikerX };

            // ── Engine validation ─────────────────────────────────────────────
            const validation = carromEngine.validateShot(currentState, userId, shot);
            if (!validation.valid) {
                return socket.emit('carrom:shot:rejected', {
                    code:    'INVALID_SHOT',
                    message: validation.reason,
                });
            }

            // ── Simulate shot ─────────────────────────────────────────────────
            const newState    = carromEngine.simulateShot(currentState, userId, shot);
            const moveNumber  = room.stateVersion + 1;
            const processingMs = Date.now() - shotStart;

            // ── Audit log (GameMove) ──────────────────────────────────────────
            // Isolated: a logging failure must not abort the gameplay.
            try {
                await GameMove.create({
                    roomId:          room._id,
                    gameName:        'carrom',
                    userId,
                    moveNumber,
                    moveType:        newState.lastShotResult?.isFoul ? 'foul' : 'shot',
                    moveData:        shot,
                    stateBeforeMove: currentState,
                    stateAfterMove:  newState,
                    processingMs,
                });
            } catch (moveErr) {
                logger.error('CARROM', `GameMove write failed for room ${room.roomCode} v${moveNumber}: ${moveErr.message}`);
            }

            // ── Update GameRoom ───────────────────────────────────────────────
            const { gameOver, winnerId } = carromEngine.checkWin(newState);
            const botPlayer   = room.players.find(p => p.isBot);
            const humanPlayer = room.players.find(p => !p.isBot);
            const nextTurnId  = newState.currentTurnPlayerId;   // userId | 'bot' | null

            // Map 'bot' playerId to null for DB field (bot has no userId ObjectId)
            const nextTurnObjectId = (!nextTurnId || nextTurnId === 'bot')
                ? null
                : nextTurnId;

            room.state             = newState;
            room.stateVersion      = moveNumber;
            room.currentTurnUserId = gameOver ? null : nextTurnObjectId;
            room.turnStartedAt     = gameOver ? null : new Date();

            if (gameOver) {
                room.status         = 'completed';
                room.completedAt    = new Date();
                room.winnerId       = (winnerId && winnerId !== 'bot') ? winnerId : null;
                room.winnerUsername = (winnerId === 'bot')
                    ? 'Robot'
                    : (humanPlayer?.username || '');
            }

            await room.save();

            logger.info(
                'CARROM',
                `Shot accepted: room ${room.roomCode} v${room.stateVersion}` +
                ` user=${userId}` +
                (newState.lastShotResult?.isFoul ? ' [FOUL]' : '') +
                (gameOver ? ` [GAME OVER → ${room.winnerUsername}]` : '')
            );

            // ── Broadcast updated state ────────────────────────────────────────
            const turnTimeoutAt = (!gameOver && room.turnStartedAt && room.turnTimeoutSeconds)
                ? new Date(room.turnStartedAt.getTime() + room.turnTimeoutSeconds * 1000)
                : null;

            v2.to(`match:${room._id}`).emit('carrom:state', {
                roomId:            room._id,
                state:             newState,
                stateVersion:      room.stateVersion,
                currentTurnUserId: room.currentTurnUserId,
                lastShotResult:    newState.lastShotResult,
                turnTimeoutAt,
            });

            // ── Game-over broadcast ────────────────────────────────────────────
            if (gameOver) {
                // Distribute reward for paid rooms (idempotent — safe to call once).
                // Sets room.winnerPrize and room.platformFee on the in-memory document.
                if (room.entryFee > 0) {
                    try {
                        await RoomManager.distributeRoomReward(room);
                    } catch (rewardErr) {
                        logger.error('CARROM', `Reward distribution failed for room ${room.roomCode}: ${rewardErr.message}`);
                    }
                }
                v2.to(`match:${room._id}`).emit('game:match:end', {
                    roomId:         room._id,
                    winnerId:       room.winnerId,
                    winnerUsername: room.winnerUsername,
                    isPractice:     room.entryFee === 0,
                    payout:         room.winnerPrize || 0,
                    platformFee:    room.platformFee  || 0,
                    finalState:     newState,
                });
                logger.info(
                    'CARROM',
                    `Room ${room.roomCode} ended — winner: ${room.winnerUsername}` +
                    (room.entryFee > 0 ? ` | payout: $${room.winnerPrize}` : '')
                );
                return;
            }

            // ── Schedule bot turn if applicable ───────────────────────────────
            if (nextTurnId === 'bot') {
                _scheduleBotTurn(
                    room._id,
                    botPlayer?.difficulty || 'easy',
                    v2,
                    moveNumber           // expected stateVersion; prevents double-fire
                );
            }

        } catch (err) {
            logger.error('CARROM', `carrom:shot error for user ${userId}: ${err.message}`);
            socket.emit('game:error', {
                code:    'SHOT_FAILED',
                message: 'Server error while processing shot. Please try again.',
            });
        }
    });
}

// ─── _scheduleBotTurn (internal) ──────────────────────────────────────────────

/**
 * Fire a bot shot after BOT_DELAY_MS.
 * Guards against:
 *   - room no longer active  (e.g. human disconnected and room was cancelled)
 *   - state changed before timeout fired (staleVersion guard)
 *   - infinite bot loops (only re-schedules if bot scored and it's still bot's turn)
 *
 * @param {string|ObjectId} roomId
 * @param {'easy'|'medium'|'hard'} difficulty
 * @param {import('socket.io').Namespace} v2
 * @param {number} expectedVersion   stateVersion at the time this was scheduled
 * @param {number} [chainCount=0]     Consecutive bot turns in this chain; capped at MAX_BOT_CHAIN
 */
function _scheduleBotTurn(roomId, difficulty, v2, expectedVersion, chainCount = 0) {
    if (chainCount >= MAX_BOT_CHAIN) {
        logger.warn(
            'CARROM',
            `Bot chain cap (${MAX_BOT_CHAIN}) reached for room ${roomId} — stopping to prevent loop`
        );
        return;
    }
    setTimeout(async () => {
        try {
            const room = await GameRoom.findById(roomId);
            if (!room)                      return;
            if (room.status !== 'active')   return;
            if (room.stateVersion !== expectedVersion) return;   // already handled

            const state = room.state;
            if (!state || state.gameOver)   return;

            // Confirm it's actually the bot's turn
            if (state.currentTurnPlayerId !== 'bot') return;

            // Pick and simulate bot shot
            const shot        = carromEngine.botPickShot(state, difficulty);
            const newState    = carromEngine.simulateShot(state, 'bot', shot);
            const moveNumber  = room.stateVersion + 1;

            // Audit log (non-critical — failure must not abort gameplay)
            try {
                await GameMove.create({
                    roomId:          room._id,
                    gameName:        'carrom',
                    userId:          null,    // bot has no userId
                    moveNumber,
                    moveType:        newState.lastShotResult?.isFoul ? 'foul' : 'shot',
                    moveData:        { ...shot, difficulty },   // include bot difficulty for audit
                    stateBeforeMove: state,
                    stateAfterMove:  newState,
                    processingMs:    0,
                });
            } catch (moveErr) {
                logger.error('CARROM', `GameMove write failed (bot) for room ${roomId} v${moveNumber}: ${moveErr.message}`);
            }

            // Update room
            const { gameOver, winnerId } = carromEngine.checkWin(newState);
            const humanPlayer  = room.players.find(p => !p.isBot);
            const botPlayer    = room.players.find(p => p.isBot);
            const nextTurnId   = newState.currentTurnPlayerId;
            const nextTurnObjectId = (!nextTurnId || nextTurnId === 'bot')
                ? null
                : nextTurnId;

            room.state             = newState;
            room.stateVersion      = moveNumber;
            room.currentTurnUserId = gameOver ? null : nextTurnObjectId;
            room.turnStartedAt     = gameOver ? null : new Date();

            if (gameOver) {
                room.status         = 'completed';
                room.completedAt    = new Date();
                room.winnerId       = (winnerId && winnerId !== 'bot') ? winnerId : null;
                room.winnerUsername = (winnerId === 'bot')
                    ? 'Robot'
                    : (humanPlayer?.username || '');
            }

            await room.save();

            // Broadcast
            const turnTimeoutAt = (!gameOver && room.turnStartedAt && room.turnTimeoutSeconds)
                ? new Date(room.turnStartedAt.getTime() + room.turnTimeoutSeconds * 1000)
                : null;

            v2.to(`match:${room._id}`).emit('carrom:state', {
                roomId:            room._id,
                state:             newState,
                stateVersion:      room.stateVersion,
                currentTurnUserId: room.currentTurnUserId,
                lastShotResult:    newState.lastShotResult,
                turnTimeoutAt,
            });

            if (gameOver) {
                // Distribute reward for paid rooms (idempotent).
                if (room.entryFee > 0) {
                    try {
                        await RoomManager.distributeRoomReward(room);
                    } catch (rewardErr) {
                        logger.error('CARROM', `Reward distribution failed (bot turn) for room ${room.roomCode}: ${rewardErr.message}`);
                    }
                }
                v2.to(`match:${room._id}`).emit('game:match:end', {
                    roomId:         room._id,
                    winnerId:       room.winnerId,
                    winnerUsername: room.winnerUsername,
                    isPractice:     room.entryFee === 0,
                    payout:         room.winnerPrize || 0,
                    platformFee:    room.platformFee  || 0,
                    finalState:     newState,
                });
                logger.info(
                    'CARROM',
                    `Room ${room.roomCode} ended (bot won) — winner: ${room.winnerUsername}`
                );
                return;
            }

            // Re-schedule if bot pocketed and still has the turn
            if (newState.currentTurnPlayerId === 'bot') {
                _scheduleBotTurn(
                    roomId,
                    botPlayer?.difficulty || difficulty,
                    v2,
                    moveNumber,
                    chainCount + 1
                );
            }

            logger.info(
                'CARROM',
                `Bot shot: room ${roomId} v${room.stateVersion}` +
                (newState.lastShotResult?.isFoul ? ' [FOUL]' : '') +
                (gameOver ? ` [GAME OVER]` : ` [chain=${chainCount}]`)
            );

        } catch (err) {
            logger.error('CARROM', `Bot turn error for room ${roomId}: ${err.message}`);
        }
    }, BOT_DELAY_MS);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { registerCarromHandlers };
