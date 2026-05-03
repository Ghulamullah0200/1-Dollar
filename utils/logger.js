/**
 * Centralized Logger — Level-based logging with timestamps
 */
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

const timestamp = () => new Date().toISOString();

const logger = {
    error: (tag, message, data = '') => {
        if (CURRENT_LEVEL >= LOG_LEVELS.ERROR)
            console.error(`[${timestamp()}] [ERROR] [${tag}] ${message}`, data || '');
    },
    warn: (tag, message, data = '') => {
        if (CURRENT_LEVEL >= LOG_LEVELS.WARN)
            console.warn(`[${timestamp()}] [WARN] [${tag}] ${message}`, data || '');
    },
    info: (tag, message, data = '') => {
        if (CURRENT_LEVEL >= LOG_LEVELS.INFO)
            console.log(`[${timestamp()}] [INFO] [${tag}] ${message}`, data || '');
    },
    debug: (tag, message, data = '') => {
        if (CURRENT_LEVEL >= LOG_LEVELS.DEBUG)
            console.log(`[${timestamp()}] [DEBUG] [${tag}] ${message}`, data || '');
    },
};

module.exports = logger;
