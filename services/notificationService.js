/**
 * Firebase Notification Service — FCM Push Notifications
 * Falls back to Socket.IO-only delivery if Firebase is not configured.
 * 
 * Functions:
 *   sendToUser(userId, title, body, data)    — Send to a specific user
 *   sendToAdmins(title, body, data)          — Send to ALL admin devices
 *   sendBroadcast(title, body, data)         — Send to all non-admin users
 *   isAvailable()                            — Check if FCM is initialized
 */
const logger = require('../utils/logger');
const User = require('../models/User');

let firebaseApp = null;
let messaging = null;

function getMessaging() {
    if (messaging) return messaging;

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || projectId === 'your_project_id' || !clientEmail || !privateKey) {
        logger.warn('FCM', 'Not configured — notifications will use Socket.IO only');
        return null;
    }

    try {
        const admin = require('firebase-admin');
        if (!firebaseApp) {
            firebaseApp = admin.initializeApp({
                credential: admin.credential.cert({
                    projectId,
                    clientEmail,
                    privateKey: privateKey.replace(/\\n/g, '\n'),
                }),
            });
            logger.info('FCM', 'Firebase Admin initialized');
        }
        messaging = admin.messaging();
        return messaging;
    } catch (err) {
        logger.error('FCM', 'Failed to initialize — install with: npm install firebase-admin', err.message);
        return null;
    }
}

/**
 * Send push notification to a single user by userId
 */
async function sendToUser(userId, title, body, data = {}) {
    const fcm = getMessaging();
    const user = await User.findById(userId).select('fcmToken username').lean();

    if (!user?.fcmToken) {
        logger.debug('FCM', `No FCM token for user ${userId} — skipping push`);
        return { success: false, reason: 'no_token' };
    }

    if (!fcm) {
        logger.debug('FCM', `Firebase not configured — skipping push for ${user.username}`);
        return { success: false, reason: 'not_configured' };
    }

    try {
        const message = {
            token: user.fcmToken,
            notification: { title, body },
            data: {
                ...data,
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                timestamp: new Date().toISOString(),
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'one_dollar_main',
                    icon: 'ic_notification',
                    color: '#00C853',
                    sound: 'default',
                },
            },
        };

        const messageId = await fcm.send(message);
        logger.info('FCM', `Push sent to ${user.username}: "${title}" (${messageId})`);
        return { success: true, messageId };
    } catch (err) {
        if (err.code === 'messaging/registration-token-not-registered' ||
            err.code === 'messaging/invalid-registration-token') {
            await User.findByIdAndUpdate(userId, { fcmToken: null });
            logger.warn('FCM', `Invalid token for ${user.username} — removed`);
        } else {
            logger.error('FCM', `Push failed for ${user.username}: ${err.message}`);
        }
        return { success: false, reason: err.code || err.message };
    }
}

/**
 * Send push notification to ALL admin devices.
 * Finds all users with status='admin' and a valid fcmToken.
 */
async function sendToAdmins(title, body, data = {}) {
    const fcm = getMessaging();
    if (!fcm) {
        logger.debug('FCM', 'Firebase not configured — skipping admin push');
        return { sent: 0, failed: 0 };
    }

    try {
        const admins = await User.find({
            status: 'admin',
            fcmToken: { $ne: null, $exists: true }
        }).select('fcmToken username').lean();

        if (admins.length === 0) {
            logger.debug('FCM', 'No admin devices with FCM tokens — skipping');
            return { sent: 0, failed: 0 };
        }

        const tokens = admins.map(a => a.fcmToken).filter(Boolean);
        if (tokens.length === 0) {
            return { sent: 0, failed: 0 };
        }

        const message = {
            tokens,
            notification: { title, body },
            data: {
                ...data,
                type: data.type || 'admin_alert',
                timestamp: new Date().toISOString(),
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'one_dollar_admin',
                    icon: 'ic_notification',
                    color: '#10B981',
                    sound: 'default',
                },
            },
        };

        const response = await fcm.sendEachForMulticast(message);

        // Cleanup invalid tokens
        response.responses.forEach((res, idx) => {
            if (!res.success && (
                res.error?.code === 'messaging/registration-token-not-registered' ||
                res.error?.code === 'messaging/invalid-registration-token'
            )) {
                User.findOneAndUpdate({ fcmToken: tokens[idx] }, { fcmToken: null }).exec();
                logger.warn('FCM', `Removed invalid admin token for ${admins[idx]?.username}`);
            }
        });

        logger.info('FCM', `Admin push: ${response.successCount} sent, ${response.failureCount} failed (${tokens.length} total)`);
        return { sent: response.successCount, failed: response.failureCount };
    } catch (err) {
        logger.error('FCM', `Admin push failed: ${err.message}`);
        return { sent: 0, failed: 0 };
    }
}

/**
 * Broadcast push notification to all non-admin users with FCM tokens
 */
async function sendBroadcast(title, body, data = {}) {
    const fcm = getMessaging();
    if (!fcm) {
        logger.debug('FCM', 'Firebase not configured — skipping broadcast push');
        return { sent: 0, failed: 0 };
    }

    const users = await User.find({
        fcmToken: { $ne: null },
        status: { $nin: ['suspended', 'banned', 'admin'] }
    }).select('fcmToken username').lean();

    if (users.length === 0) {
        logger.info('FCM', 'No users with FCM tokens — skipping broadcast');
        return { sent: 0, failed: 0 };
    }

    const tokens = users.map(u => u.fcmToken).filter(Boolean);

    try {
        const batchSize = 500;
        let totalSent = 0;
        let totalFailed = 0;

        for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);
            const message = {
                tokens: batch,
                notification: { title, body },
                data: { ...data, type: 'broadcast', timestamp: new Date().toISOString() },
                android: {
                    priority: 'high',
                    notification: {
                        channelId: 'one_dollar_main',
                        icon: 'ic_notification',
                        color: '#00C853',
                        sound: 'default',
                    },
                },
            };

            const response = await fcm.sendEachForMulticast(message);
            totalSent += response.successCount;
            totalFailed += response.failureCount;

            response.responses.forEach((res, idx) => {
                if (!res.success && res.error?.code === 'messaging/registration-token-not-registered') {
                    User.findOneAndUpdate({ fcmToken: batch[idx] }, { fcmToken: null }).exec();
                }
            });
        }

        logger.info('FCM', `Broadcast: ${totalSent} sent, ${totalFailed} failed (${tokens.length} total)`);
        return { sent: totalSent, failed: totalFailed };
    } catch (err) {
        logger.error('FCM', `Broadcast failed: ${err.message}`);
        return { sent: 0, failed: tokens.length };
    }
}

function isAvailable() {
    return getMessaging() !== null;
}

module.exports = { sendToUser, sendToAdmins, sendBroadcast, isAvailable };
