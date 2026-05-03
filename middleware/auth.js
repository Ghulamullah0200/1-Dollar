const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Standard JWT auth middleware
const auth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Authentication required' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        if (!user) return res.status(401).json({ message: 'User not found' });
        if (user.status === 'suspended') return res.status(403).json({ message: 'Account suspended' });
        if (user.status === 'banned') return res.status(403).json({ message: 'Account banned. No further actions allowed.' });

        req.user = user;
        req.userId = user._id;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Invalid or expired token' });
    }
};

// Admin-only middleware
const adminAuth = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Authentication required' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);

        if (!user || user.status !== 'admin') {
            return res.status(403).json({ message: 'Admin access required' });
        }

        req.user = user;
        req.userId = user._id;
        next();
    } catch (err) {
        res.status(401).json({ message: 'Invalid or expired token' });
    }
};

module.exports = { auth, adminAuth };
