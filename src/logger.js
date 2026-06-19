'use strict';

/**
 * Shared structured logger for the modernized modules (storage, setup, security, db).
 * Mirrors the look of the existing winston setup but is self-contained so new
 * modules don't depend on bot.js/webserver.js internals.
 */

const fs = require('fs');
const path = require('path');
const winston = require('winston');

const LOG_DIR = path.join(process.cwd(), 'logs');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {
  /* ignore */
}

const level = process.env.LOG_LEVEL || 'info';

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level: lvl, message, module }) => {
    const tag = module ? `[${module}] ` : '';
    return `${timestamp} ${lvl}: ${tag}${message}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

const baseLogger = winston.createLogger({
  level,
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

/**
 * Returns a child-style logger tagged with a module name.
 * @param {string} moduleName
 */
function createLogger(moduleName) {
  return {
    info: (msg, meta = {}) => baseLogger.info(msg, { module: moduleName, ...meta }),
    warn: (msg, meta = {}) => baseLogger.warn(msg, { module: moduleName, ...meta }),
    error: (msg, meta = {}) => baseLogger.error(msg, { module: moduleName, ...meta }),
    debug: (msg, meta = {}) => baseLogger.debug(msg, { module: moduleName, ...meta }),
  };
}

module.exports = { baseLogger, createLogger };
