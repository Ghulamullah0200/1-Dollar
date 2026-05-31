'use strict';

/**
 * ludoSocket.js — Socket.IO event handlers for Ludo online multiplayer
 *
 * All handlers run inside the authenticated /v2 namespace.
 * Only the current player (currentTurnUserId) may roll dice or move tokens.
 *
 * Events registered per socket:
 *   ludo:dice:roll    — Roll dice for the current turn
 *   ludo:token:move   — Move a specific token after dice is rolled
 *
 * Events emitted to room (match:<roomId>):
 *   ludo:dice:result  — Dice rolled; includes movable tokens list
 *   ludo:state        — State after a move
 *   ludo:move:rejected — Invalid action
 *   game:match:end    — Game over
 */

const logger     = require('../../utils/logger');
const GameRoom   = require('../models/GameRoom');
const GameMove   = require('../models/GameMove');
const ludoEngine = require('../engines/ludoEngine');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch the room and run standard guards.
 * Returns { room, error } — if error is set, caller should return.
 */
async function _loadAndGuard(socket, roomId, checkTurn = true) {
    if (!roomId) {
        return { room: null, error: { code: 'BAD_REQUEST', message: 'roomId is required.' } };
    }

    const room = await GameRoom.findById(roomId);
    if (!room) {
        return { room: null, error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' } };
    }
    if (room.gameName !== 'ludo') {
        return { room: null, error: { code: 'WRONG_GAME', message: 'Room is not a Ludo room.' } };
    }
    if (room.status !== 'active') {
        return {
            room: null,
            error: {
                code:    'ROOM_NOT_ACTIVE',
                message: `Game is paused or not active (status: ${room.status}).`,
            }
        };
    }
    if (checkTurn && room.currentTurnUserId?.toString() !== socket.userId) {
        return {
            room: null,
            error: { code: 'NOT_YOUR_TURN', message: 'It is not your turn.' }
        };
    }

    return { room, error: null };
}

/**
 * Emit a `game:match:end` event and update the room document.
 */
async function _finalizeGame(ioV2, room, winnerColor, winnerId) {
    const winnerPlayer = room.players.find(p => p.userId?.toString() === winnerId);
    const winnerUsername = winnerPlayer?.username || 'Unknown';

    room.status         = 'completed';
    room.winnerId       = winnerId || null;
    room.winnerUsername = winnerUsername;
    room.completedAt    = new Date();
    room.rewardDistributed = true;  // demo mode: no payout, mark as done

    await room.save();

    const payload = {
        roomId:          room._id,
        gameName:        'ludo',
        winnerId:        winnerId || null,
        winnerUsername,
        winnerColor,
        payout:          0,       // demo mode — no wallet deduction
        platformFee:     0,
        reason:          'game_over',
    };

    ioV2.to(`match:${room._id}`).emit('game:match:end', payload);

    logger.info('LUDO', `Room ${room.roomCode} ended — winner: ${winnerUsername} (${winnerColor})`);
}

// ─── registerLudoHandlers ─────────────────────────────────────────────────────

/**
 * Register all Ludo-specific socket event handlers on a socket.
 *
 * @param {Socket} socket   Authenticated /v2 socket
 * @param {Namespace} ioV2  /v2 namespace instance (for room broadcasts)
 */
function registerLudoHandlers(socket, ioV2) {

    // ── ludo:dice:roll ────────────────────────────────────────────────────────
    /**
     * Client: socket.emit('ludo:dice:roll', { roomId, stateVersion })
     *
     * Server validates:
     *   - Room is active Ludo room
     *   - Caller is current turn player
     *   - Dice not already rolled this turn
     *   - stateVersion matches to prevent stale actions
     *
     * Server emits to room: 'ludo:dice:result'
     */
    socket.on('ludo:dice:roll', async (data) => {
        const { roomId, stateVersion } = data || {};

        try {
            const { room, error } = await _loadAndGuard(socket, roomId, true);
            if (error) {
                return socket.emit('ludo:move:rejected', error);
            }

            // Stale version guard
            if (typeof stateVersion === 'number' && stateVersion !== room.stateVersion) {
                return socket.emit('ludo:move:rejected', {
                    code:    'STALE_STATE',
                    message: `State version mismatch. Got ${stateVersion}, server has ${room.stateVersion}.`,
                });
            }

            // Must not have already rolled
            if (room.state?.diceRolled) {
                return socket.emit('ludo:move:rejected', {
                    code:    'DICE_ALREADY_ROLLED',
                    message: 'Dice already rolled. Move a token or wait for auto-pass.',
                });
            }

            // Roll the dice (server-side, cryptographically secure)
            const diceValue = ludoEngine.rollDice();

            // Apply roll to state (may auto-pass if no moves)
            const { newState, movableTokens, autoPassed } =
                ludoEngine.applyRoll(room.state, socket.userId, diceValue);

            // Persist
            room.state        = newState;
            room.stateVersion += 1;
            if (autoPassed) {
                // Turn passed — update room's turn tracking
                room.currentTurnUserId = newState.currentTurnUserId
                    ? newState.players[newState.currentTurnColor]
                    : null;
            }
            room.turnStartedAt = new Date();
            await room.save();

            // Log the dice roll
            const moveCount = await GameMove.countDocuments({ roomId: room._id });
            await GameMove.create({
                roomId:      room._id,
                gameName:    'ludo',
                userId:      socket.userId,
                moveNumber:  moveCount + 1,
                moveType:    'dice_roll',
                moveData:    { diceValue, autoPassed, movableTokens },
                processingMs: 0,
            });

            // Broadcast dice result to all room members
            ioV2.to(`match:${room._id}`).emit('ludo:dice:result', {
                diceValue,
                movableTokens,
                autoPassed,
                stateVersion:      room.stateVersion,
                currentTurnUserId: newState.currentTurnUserId
                    ? String(newState.players[newState.currentTurnColor] || newState.currentTurnUserId)
                    : null,
                currentTurnColor:  newState.currentTurnColor,
            });

            if (autoPassed) {
                // Also emit full state so all clients sync turn
                ioV2.to(`match:${room._id}`).emit('ludo:state', {
                    state:             newState,
                    stateVersion:      room.stateVersion,
                    currentTurnUserId: newState.currentTurnUserId
                        ? String(newState.players[newState.currentTurnColor] || '')
                        : null,
                    currentTurnColor:  newState.currentTurnColor,
                });
            }

        } catch (err) {
            logger.error('LUDO', `ludo:dice:roll error [${roomId}]: ${err.message}`);
            socket.emit('ludo:move:rejected', {
                code:    'SERVER_ERROR',
                message: 'Internal server error. Please try again.',
            });
        }
    });

    // ── ludo:token:move ───────────────────────────────────────────────────────
    /**
     * Client: socket.emit('ludo:token:move', { roomId, tokenId, stateVersion })
     *
     * Server validates:
     *   - Room active, caller's turn, dice already rolled
     *   - tokenId is in movable tokens list
     *   - stateVersion matches
     *
     * Server emits to room: 'ludo:state' (and 'game:match:end' if game over)
     */
    socket.on('ludo:token:move', async (data) => {
        const { roomId, tokenId, stateVersion } = data || {};

        try {
            const { room, error } = await _loadAndGuard(socket, roomId, true);
            if (error) {
                return socket.emit('ludo:move:rejected', error);
            }

            // Stale version guard
            if (typeof stateVersion === 'number' && stateVersion !== room.stateVersion) {
                return socket.emit('ludo:move:rejected', {
                    code:    'STALE_STATE',
                    message: `State version mismatch. Got ${stateVersion}, server has ${room.stateVersion}.`,
                });
            }

            // Must have rolled first
            if (!room.state?.diceRolled) {
                return socket.emit('ludo:move:rejected', {
                    code:    'DICE_NOT_ROLLED',
                    message: 'Roll the dice first.',
                });
            }

            // Validate the move
            const validation = ludoEngine.validateMove(room.state, socket.userId, tokenId);
            if (!validation.valid) {
                return socket.emit('ludo:move:rejected', {
                    code:    'INVALID_MOVE',
                    message: validation.reason,
                });
            }

            // Apply the move
            const newState = ludoEngine.applyMove(room.state, socket.userId, tokenId);

            // Update room
            room.state        = newState;
            room.stateVersion += 1;
            room.currentTurnUserId = newState.currentTurnUserId
                ? newState.players?.[newState.currentTurnColor] || null
                : null;
            room.turnStartedAt = new Date();
            await room.save();

            // Log the move
            const moveCount = await GameMove.countDocuments({ roomId: room._id });
            await GameMove.create({
                roomId:      room._id,
                gameName:    'ludo',
                userId:      socket.userId,
                moveNumber:  moveCount + 1,
                moveType:    'token_move',
                moveData:    { tokenId, lastEvent: newState.lastEvent },
                processingMs: 0,
            });

            // Check for game over
            const { gameOver, winnerColor, winnerId } = ludoEngine.checkWin(newState);

            if (gameOver) {
                await _finalizeGame(ioV2, room, winnerColor, winnerId);
                return;
            }

            // Broadcast updated state to all room members
            ioV2.to(`match:${room._id}`).emit('ludo:state', {
                state:             newState,
                stateVersion:      room.stateVersion,
                currentTurnUserId: newState.currentTurnUserId
                    ? String(newState.players[newState.currentTurnColor] || '')
                    : null,
                currentTurnColor:  newState.currentTurnColor,
                lastEvent:         newState.lastEvent,
            });

        } catch (err) {
            logger.error('LUDO', `ludo:token:move error [${roomId}]: ${err.message}`);
            socket.emit('ludo:move:rejected', {
                code:    'SERVER_ERROR',
                message: 'Internal server error. Please try again.',
            });
        }
    });
}

module.exports = { registerLudoHandlers };
