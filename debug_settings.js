const mongoose = require('mongoose');
require('dotenv').config();

async function checkSettings() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const Settings = require('./models/Settings');
        const settings = await Settings.getSettings();
        console.log('Current Settings Object:', JSON.stringify(settings, null, 2));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkSettings();
