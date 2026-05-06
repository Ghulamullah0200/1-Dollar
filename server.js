/**
 * ════════════════════════════════════════════════════
 * 1 DOLLAR — Referral-Based Earning System
 * ════════════════════════════════════════════════════
 * 
 * Architecture:
 * ├── server.js           ← This file (entry point)
 * ├── api/
 * │   ├── auth.js         ← Register, Login, Change Password
 * │   ├── user.js         ← Dashboard, Wallet, Transactions, FCM
 * │   ├── withdrawal.js   ← Withdrawal requests
 * │   ├── config.js       ← App version, Feature flags
 * │   └── admin/
 * │       └── index.js    ← Admin panel (users, withdrawals, fraud, notifications)
 * ├── models/             ← Mongoose schemas
 * ├── middleware/          ← Auth, Error handling
 * ├── services/           ← FCM notification service
 * └── utils/              ← Logger, Helpers
 */

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');

// ═══════════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

// ═══════════════════════════════════════════════════
// GLOBAL MIDDLEWARE
// ═══════════════════════════════════════════════════
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Attach Socket.IO to every request for real-time events
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Rate limiting — global 100 requests per 15 min
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { message: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { message: 'Too many login attempts. Please wait 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ═══════════════════════════════════════════════════
// API ROUTES — Modular Structure
// ═══════════════════════════════════════════════════
const authRoutes = require('./api/auth');
const userRoutes = require('./api/user');
const withdrawalRoutes = require('./api/withdrawal');
const depositRoutes = require('./api/deposit');
const configRoutes = require('./api/config');
const adminRoutes = require('./api/admin');
const activityRoutes = require('./api/activity');

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/withdraw', withdrawalRoutes);
app.use('/api/deposit', depositRoutes);
app.use('/api/config', configRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/activity', activityRoutes);

// ═══════════════════════════════════════════════════
// BACKWARD-COMPATIBLE ALIASES
// ═══════════════════════════════════════════════════
// Some client endpoints use /api/wallet, /api/transactions directly
app.use('/api/wallet', (req, res, next) => {
    req.url = '/wallet' + (req.url === '/' ? '' : req.url);
    userRoutes(req, res, next);
});
app.use('/api/transactions', (req, res, next) => {
    req.url = '/transactions' + (req.url === '/' ? '' : req.url);
    userRoutes(req, res, next);
});

// ═══════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════
app.get('/', (req, res) => {
    res.json({
        name: '1 Dollar API',
        version: '2.0.0',
        status: 'running',
        system: 'Referral-Based Earning',
        uptime: Math.floor(process.uptime()) + 's',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ═══════════════════════════════════════════════════
// SOCKET.IO — Real-time Events
// ═══════════════════════════════════════════════════
io.on('connection', (socket) => {
    logger.debug('SOCKET', `Client connected: ${socket.id}`);

    socket.on('disconnect', () => {
        logger.debug('SOCKET', `Client disconnected: ${socket.id}`);
    });
});

// ═══════════════════════════════════════════════════
// ERROR HANDLER (must be last)
// ═══════════════════════════════════════════════════
app.use(errorHandler);

// ═══════════════════════════════════════════════════
// DATABASE & SERVER STARTUP
// ═══════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        logger.info('DB', '✅ MongoDB connected');

        // Auto-create admin if none exists
        const User = require('./models/User');
        const existingAdmin = await User.findOne({ status: 'admin' });
        if (!existingAdmin) {
            const admin = new User({
                username: 'admin',
                email: 'admin@1dollar.info',
                password: 'admin123',
                status: 'admin',
                referralCode: 'ADMIN001'
            });
            await admin.save();
            logger.info('SETUP', '🔑 Default admin created — username: admin, password: admin123');
        }

        server.listen(PORT, () => {
            logger.info('SERVER', `
╔══════════════════════════════════════════╗
║   1 DOLLAR — Referral Earning System     ║
╠══════════════════════════════════════════╣
║   Port:    ${PORT}                          ║
║   Mode:    ${process.env.NODE_ENV || 'development'}                ║
║   System:  Referral-Based ($0.50/ref)    ║
║   Signup:  $0.10 bonus                   ║
║   Min W/D: $1.00                         ║
╚══════════════════════════════════════════╝`);
        });
    })
    .catch(err => {
        logger.error('DB', '❌ MongoDB connection failed', err.message);
        process.exit(1);
    });

module.exports = { app, server, io };
