'use strict';

const jwt = require('jsonwebtoken');
const User = require('../../models/User');
const logger = require('../../utils/logger');
const RoomManager = require('../services/roomManager');
const { registerCarromHandlers } = require('./carromSocket');
const { registerLudoHandlers }   = require('./ludoSocket');

/**
 * Initialize the authenticated /v2 Socket.IO namespace.
 *
 * Security model:
 *   - JWT required on every connection via handshake.auth.token
 *     (handshake.query.token accepted as a fallback for environments
 *      that cannot set auth headers)
 *   - Suspended / banned users are rejected at the middleware level
 *   - Token payload is never logged
 *
 * Room layout:
 *   user:<userId>          — auto-joined on connect; personal events only
 *   admin:notifications    — auto-joined for admin users
 *   match:<matchId>        — client requests join via 'match:join' event;
 *                            server validates participation before granting access
 *
 * OM1+ online multiplayer events (Carrom + Ludo):
 *   game:online:find       — auto-matchmaking (find or create waiting room)
 *   game:online:cancel     — cancel a waiting online room and refund
 */
function initV2Namespace(io) {
    const v2 = io.of('/v2');

    // ─── Authentication middleware ─────────────────────────────────────────────
    v2.use(async (socket, next) => {
        const token =
            socket.handshake.auth?.token ||
            socket.handshake.query?.token;

        if (!token) {
            return next(Object.assign(new Error('AUTH_MISSING'), {
                data: { message: 'Authentication token required' }
            }));
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (_) {
            return next(Object.assign(new Error('AUTH_INVALID'), {
                data: { message: 'Invalid or expired token' }
            }));
        }

        try {
            const user = await User.findById(decoded.id)
                .select('_id username status')
                .lean();

            if (!user) {
                return next(Object.assign(new Error('AUTH_USER_NOT_FOUND'), {
                    data: { message: 'User not found' }
                }));
            }

            if (user.status === 'suspended' || user.status === 'banned') {
                return next(Object.assign(new Error('AUTH_FORBIDDEN'), {
                    data: { message: 'Account suspended or banned' }
                }));
            }

            socket.userId = user._id.toString();
            socket.user = user;
            next();
        } catch (err) {
            logger.error('SOCKET_V2', `DB error during auth: ${err.message}`);
            next(new Error('AUTH_ERROR'));
        }
    });

    // ─── Connection handler ────────────────────────────────────────────────────
    v2.on('connection', (socket) => {
        const userId = socket.userId;
        const isAdmin = socket.user.status === 'admin';

        logger.debug('SOCKET_V2', `${socket.user.username} (${userId}) connected [${socket.id}]`);

        // Every authenticated user is auto-joined to their personal room.
        // No client event required — the server controls room membership.
        socket.join(`user:${userId}`);

        // Admins are auto-joined to the admin notifications room.
        if (isAdmin) {
            socket.join('admin:notifications');
            logger.debug('SOCKET_V2', `Admin ${socket.user.username} joined admin:notifications`);
        }

        // ── match:join ─────────────────────────────────────────────────────────
        // Client sends: socket.emit('match:join', matchId)
        // Server validates that the requesting user is a match participant or admin.
        socket.on('match:join', async (matchId) => {
            if (!matchId) return;
            try {
                const GameMatch = require('../models/GameMatch');
                const match = await GameMatch.findById(matchId).select('players').lean();

                if (!match) {
                    return socket.emit('match:join:error', { message: 'Match not found' });
                }

                const isParticipant = match.players.some(
                    (p) => p.userId.toString() === userId
                );

                if (!isParticipant && !isAdmin) {
                    return socket.emit('match:join:error', {
                        message: 'Not authorized — you are not a participant in this match'
                    });
                }

                socket.join(`match:${matchId}`);
                logger.debug('SOCKET_V2', `${userId} joined match:${matchId}`);
            } catch (err) {
                logger.error('SOCKET_V2', `match:join error for ${userId}: ${err.message}`);
            }
        });

        // ── match:leave ────────────────────────────────────────────────────────
        socket.on('match:leave', (matchId) => {
            if (!matchId) return;
            socket.leave(`match:${matchId}`);
            logger.debug('SOCKET_V2', `${userId} left match:${matchId}`);
        });

        // ─────────────────────────────────────────────────────────────────────
        // CARROM EVENTS  (Phase 2 — free practice + bot mode)
        // ─────────────────────────────────────────────────────────────────────
        registerCarromHandlers(socket, v2);

        // ─────────────────────────────────────────────────────────────────────
        // LUDO EVENTS  (Ludo online 2-player demo)
        // ─────────────────────────────────────────────────────────────────────
        registerLudoHandlers(socket, v2);

        // ─────────────────────────────────────────────────────────────────────
        // ROOM EVENTS  (Carrom / Ludo — turn-based games only)
        // flappy-bird and fruit-ninja are explicitly rejected below.
        // ─────────────────────────────────────────────────────────────────────

        // ── game:room:create ───────────────────────────────────────────────────
        // Client: socket.emit('game:room:create', { gameName, entryFee, mode, difficulty })
        socket.on('game:room:create', async (payload) => {
            try {
                const { gameName, entryFee, mode, difficulty } = payload || {};

                if (gameName === 'flappy-bird' || gameName === 'fruit-ninja') {
                    return socket.emit('game:error', {
                        code: 'WRONG_GAME_SYSTEM',
                        message: `${gameName} uses the queue system, not the room system.`
                    });
                }

                const room = await RoomManager.createRoom(
                    userId, gameName, entryFee, mode, difficulty
                );

                socket.join(`match:${room._id}`);

                socket.emit('game:room:created', {
                    roomId:   room._id,
                    roomCode: room.roomCode,
                    status:   room.status,
                    gameName: room.gameName,
                    mode:     room.mode,
                    entryFee: room.entryFee,
                    players:  room.players
                });

                if (room.status === 'active') {
                    // Bot mode: immediately active — send game:room:start to creator
                    socket.emit('game:room:start', {
                        roomId:            room._id,
                        state:             room.state,
                        players:           room.players,
                        currentTurnUserId: room.currentTurnUserId,
                        turnTimeoutAt: room.turnStartedAt && room.turnTimeoutSeconds
                            ? new Date(room.turnStartedAt.getTime() + room.turnTimeoutSeconds * 1000)
                            : null
                    });
                }

                logger.info('SOCKET_V2', `${socket.user.username} created room ${room.roomCode}`);
            } catch (err) {
                socket.emit('game:error', { code: 'ROOM_CREATE_FAILED', message: err.message });
            }
        });

        // ── game:room:join ─────────────────────────────────────────────────────
        // Client: socket.emit('game:room:join', { roomCode })
        socket.on('game:room:join', async (payload) => {
            try {
                const { roomCode } = payload || {};
                if (!roomCode) {
                    return socket.emit('game:error', {
                        code: 'INVALID_PARAMS',
                        message: 'roomCode is required'
                    });
                }

                const room = await RoomManager.joinRoom(userId, roomCode);

                socket.join(`match:${room._id}`);

                const joinedPayload = {
                    roomId:   room._id,
                    players:  room.players,
                    status:   room.status,
                    gameName: room.gameName
                };

                // Notify the creator and any other room participants
                socket.to(`match:${room._id}`).emit('game:room:joined', joinedPayload);
                // Notify the joiner
                socket.emit('game:room:joined', joinedPayload);

                if (room.status === 'active') {
                    // 2nd player joined — broadcast game:room:start to the whole room
                    v2.to(`match:${room._id}`).emit('game:room:start', {
                        roomId:            room._id,
                        state:             room.state,
                        players:           room.players,
                        currentTurnUserId: room.currentTurnUserId,
                        turnTimeoutAt: room.turnStartedAt && room.turnTimeoutSeconds
                            ? new Date(room.turnStartedAt.getTime() + room.turnTimeoutSeconds * 1000)
                            : null
                    });
                }

                logger.info('SOCKET_V2', `${socket.user.username} joined room ${room.roomCode}`);
            } catch (err) {
                socket.emit('game:error', { code: 'ROOM_JOIN_FAILED', message: err.message });
            }
        });

        // ── game:room:leave ────────────────────────────────────────────────────
        // Client: socket.emit('game:room:leave', { roomId })
        socket.on('game:room:leave', async (payload) => {
            try {
                const { roomId } = payload || {};
                if (!roomId) {
                    return socket.emit('game:error', {
                        code: 'INVALID_PARAMS',
                        message: 'roomId is required'
                    });
                }

                const room = await RoomManager.leaveRoom(userId, roomId);

                if (room.status === 'completed' && room.cancelReason === 'forfeit') {
                    // Paid bot room was forfeited mid-game — emit game:match:end so any
                    // still-connected client receives a proper result screen.
                    v2.to(`match:${room._id}`).emit('game:match:end', {
                        roomId:         room._id,
                        winnerId:       null,
                        winnerUsername: room.winnerUsername || 'Robot',
                        isPractice:     false,
                        payout:         0,
                        platformFee:    room.platformFee || room.totalPool || 0,
                        finalState:     room.state,
                        forfeit:        true,
                    });
                } else {
                    // Waiting room cancelled or refunded leave — standard notification
                    v2.to(`match:${room._id}`).emit('game:room:left', {
                        roomId:       room._id,
                        leftUserId:   userId,
                        status:       room.status,
                        cancelReason: room.cancelReason
                    });
                }

                socket.leave(`match:${room._id}`);

                logger.info('SOCKET_V2', `${socket.user.username} left room ${room._id}`);
            } catch (err) {
                socket.emit('game:error', { code: 'ROOM_LEAVE_FAILED', message: err.message });
            }
        });

        // ─────────────────────────────────────────────────────────────────────
        // ONLINE MATCHMAKING EVENTS  (OM1 — Carrom online multiplayer)
        // ─────────────────────────────────────────────────────────────────────

        // ── game:online:find ───────────────────────────────────────────────────
        // Client: socket.emit('game:online:find', { gameName, entryFee })
        //
        // Auto-matchmaking:
        //   - If a valid waiting room exists for the same gameName+entryFee,
        //     joins it (User B path) → room activates → game:room:start broadcast.
        //   - Otherwise creates a new waiting room (User A path) → game:room:joined
        //     with status:'waiting'.
        // The socket automatically joins match:<roomId> in both cases.
        socket.on('game:online:find', async (payload) => {
            try {
                const { gameName, entryFee } = payload || {};

                if (!gameName) {
                    return socket.emit('game:error', {
                        code:    'INVALID_PARAMS',
                        message: 'gameName is required.',
                    });
                }

                const result = await RoomManager.findOrCreateOnlineRoom(
                    userId, gameName, entryFee
                );
                const { room, matched, message } = result;

                // Join the socket to this match room so subsequent broadcasts reach us.
                socket.join(`match:${room._id}`);

                // Always notify the requesting user they've joined/created a room.
                socket.emit('game:room:joined', {
                    roomId:   room._id,
                    roomCode: room.roomCode,
                    status:   room.status,
                    mode:     'online',
                    entryFee: room.entryFee,
                    players:  room.players,
                    message,
                });

                if (matched && room.status === 'active') {
                    // Both players are present — notify User A (waiting) that opponent joined.
                    socket.to(`match:${room._id}`).emit('game:room:joined', {
                        roomId:   room._id,
                        roomCode: room.roomCode,
                        status:   room.status,
                        mode:     'online',
                        entryFee: room.entryFee,
                        players:  room.players,
                        message:  'Opponent found! Game starting.',
                    });

                    // Broadcast game:room:start to the whole match room (User A + User B).
                    const turnTimeoutAt = room.turnStartedAt && room.turnTimeoutSeconds
                        ? new Date(
                            room.turnStartedAt.getTime() +
                            room.turnTimeoutSeconds * 1000
                          )
                        : null;

                    v2.to(`match:${room._id}`).emit('game:room:start', {
                        roomId:             room._id,
                        gameName:           room.gameName,
                        state:              room.state,
                        players:            room.players,
                        currentTurnUserId:  room.currentTurnUserId,
                        currentTurnColor:   room.state?.currentTurnColor || null,
                        turnTimeoutAt,
                        mode:               'online',
                    });
                }

                logger.info(
                    'SOCKET_V2',
                    `${socket.user.username} ${
                        matched ? 'matched into' : 'created waiting'
                    } online room ${room.roomCode} [fee:${room.entryFee}]`
                );
            } catch (err) {
                socket.emit('game:error', {
                    code:    'ONLINE_FIND_FAILED',
                    message: err.message,
                });
            }
        });

        // ── game:online:cancel ─────────────────────────────────────────────────
        // Client: socket.emit('game:online:cancel', { roomId })
        //
        // Cancels a waiting online room that this user created while searching
        // for an opponent. Refunds the entry fee. Rejected if room is already active.
        socket.on('game:online:cancel', async (payload) => {
            try {
                const { roomId } = payload || {};

                if (!roomId) {
                    return socket.emit('game:error', {
                        code:    'INVALID_PARAMS',
                        message: 'roomId is required.',
                    });
                }

                const room = await RoomManager.cancelOnlineSearch(userId, roomId);

                socket.leave(`match:${room._id}`);

                socket.emit('game:room:cancelled', {
                    roomId:   room._id,
                    reason:   room.cancelReason,
                    message:  'Search cancelled.' + (room.entryFee > 0 ? ' Entry fee refunded.' : ''),
                    refunded: room.entryFee > 0,
                });

                logger.info(
                    'SOCKET_V2',
                    `${socket.user.username} cancelled online search — room ${room.roomCode}`
                );
            } catch (err) {
                socket.emit('game:error', {
                    code:    'ONLINE_CANCEL_FAILED',
                    message: err.message,
                });
            }
        });

        // ── game:reconnect ─────────────────────────────────────────────────────
        // Client: socket.emit('game:reconnect', { roomId })
        // Called when a socket reconnects mid-game to restore authoritative state.
        socket.on('game:reconnect', async (payload) => {
            try {
                const { roomId } = payload || {};
                if (!roomId) {
                    return socket.emit('game:error', {
                        code: 'INVALID_PARAMS',
                        message: 'roomId is required'
                    });
                }

                const snapshot = await RoomManager.reconnectUser(userId, roomId);

                socket.join(`match:${snapshot.room._id}`);

                socket.emit('game:reconnected', {
                    roomId:            snapshot.room._id,
                    state:             snapshot.state,
                    stateVersion:      snapshot.stateVersion,
                    currentTurnUserId: snapshot.currentTurnUserId,
                    turnTimeoutAt:     snapshot.turnTimeoutAt,
                    players:           snapshot.players,
                    finished:          snapshot.finished
                });

                if (!snapshot.finished) {
                    // Notify the opponent that this player is back
                    socket.to(`match:${snapshot.room._id}`).emit('game:player:reconnected', {
                        roomId: snapshot.room._id,
                        userId
                    });
                }

                logger.info('SOCKET_V2', `${socket.user.username} reconnected to room ${snapshot.room._id}`);
            } catch (err) {
                socket.emit('game:error', { code: 'RECONNECT_FAILED', message: err.message });
            }
        });

        // ── disconnect ─────────────────────────────────────────────────────────
        socket.on('disconnect', async () => {
            logger.debug('SOCKET_V2', `${socket.user.username} (${userId}) disconnected [${socket.id}]`);

            try {
                const GameRoom = require('../models/GameRoom');
                const room = await GameRoom.getActiveForUser(userId);
                if (room && ['active', 'paused'].includes(room.status)) {
                    const player = room.players.find(
                        p => p.userId && p.userId.toString() === userId
                    );
                    if (player) {
                        if (room.mode === 'bot') {
                            if (room.entryFee > 0 && room.stateVersion > 0) {
                                // Paid bot game in progress: forfeit — bot wins, platform keeps pool.
                                // Documented behavior: leaving a paid bot game mid-match is a forfeit.
                                try {
                                    await RoomManager.forfeitBotRoom(room);
                                    // Only emit if the forfeit actually succeeded.
                                    // If another call (e.g. a concurrent winning shot) already
                                    // completed the room, forfeitBotRoom returns the original
                                    // room unchanged (cancelReason stays null) — skip the emit
                                    // so we don't overwrite the real game:match:end already sent.
                                    if (room.cancelReason === 'forfeit') {
                                        v2.to(`match:${room._id}`).emit('game:match:end', {
                                            roomId:         room._id,
                                            winnerId:       null,
                                            winnerUsername: 'Robot',
                                            isPractice:     false,
                                            payout:         0,
                                            platformFee:    room.totalPool,
                                            finalState:     room.state,
                                            forfeit:        true,
                                        });
                                        logger.info(
                                            'SOCKET_V2',
                                            `Paid bot room ${room.roomCode} forfeited on disconnect — platform keeps $${room.totalPool}`
                                        );
                                    } else {
                                        logger.info(
                                            'SOCKET_V2',
                                            `Paid bot room ${room.roomCode} already completed on disconnect — forfeit skipped`
                                        );
                                    }
                                } catch (forfeitErr) {
                                    logger.warn('SOCKET_V2', `Paid bot room forfeit failed: ${forfeitErr.message}`);
                                }
                            } else {
                                // Free practice or paid room not yet started (stateVersion === 0): cancel + refund.
                                try {
                                    await RoomManager.leaveRoom(userId, room._id);
                                    logger.info(
                                        'SOCKET_V2',
                                        `Bot room ${room.roomCode} auto-cancelled on disconnect for ${socket.user.username}`
                                    );
                                } catch (cancelErr) {
                                    logger.warn('SOCKET_V2', `Bot room auto-cancel skipped: ${cancelErr.message}`);
                                }
                            }
                        } else {
                            // Online rooms: pause the game and start the reconnect window.
                            // finalizeDisconnectedRooms() will forfeit if they don't return in time.
                            player.isConnected    = false;
                            player.disconnectedAt = new Date();
                            if (room.status === 'active') room.status = 'paused';
                            await room.save();

                            const reconnectSecs = (room.settings && room.settings.reconnectTimeoutSeconds) || 60;
                            v2.to(`match:${room._id}`).emit('game:player:disconnected', {
                                roomId:                 room._id,
                                userId,
                                username:               socket.user.username,
                                reconnectWindowSeconds: reconnectSecs,
                                reconnectDeadlineAt:    new Date(Date.now() + reconnectSecs * 1000),
                            });

                            logger.info(
                                'SOCKET_V2',
                                `${socket.user.username} disconnected from online room ${room.roomCode} — paused`
                            );
                        }
                    }
                }
            } catch (roomErr) {
                logger.error('SOCKET_V2', `Disconnect room update failed: ${roomErr.message}`);
            }
        });
    });

    return v2;
}

module.exports = { initV2Namespace };
