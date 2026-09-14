'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Minimal file + console logger. Avoids pulling in a heavy dependency.
 * Logs are written to <userData>/logs/mediadownloader.log and rotated
 * when they exceed 5 MB.
 */
class Logger {
  constructor() {
    this.logDir = path.join(app.getPath('userData'), 'logs');
    this.logFile = path.join(this.logDir, 'mediadownloader.log');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this._rotateIfNeeded();
  }

  _rotateIfNeeded() {
    try {
      if (fs.existsSync(this.logFile)) {
        const { size } = fs.statSync(this.logFile);
        if (size > 5 * 1024 * 1024) {
          const backup = this.logFile.replace('.log', `.${Date.now()}.log`);
          fs.renameSync(this.logFile, backup);
        }
      }
    } catch (_) {
      // Non-fatal; logging should never crash the app.
    }
  }

  _write(level, message, meta) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}${
      meta ? ' ' + safeStringify(meta) : ''
    }\n`;
    try {
      fs.appendFileSync(this.logFile, line);
    } catch (_) {
      /* ignore disk errors */
    }
    const consoleFn = level === 'ERROR' ? console.error : console.log;
    consoleFn(line.trim());
  }

  info(message, meta) {
    this._write('INFO', message, meta);
  }

  warn(message, meta) {
    this._write('WARN', message, meta);
  }

  error(message, meta) {
    this._write('ERROR', message, meta);
  }
}

function safeStringify(obj) {
  try {
    if (obj instanceof Error) {
      return `${obj.message}\n${obj.stack || ''}`;
    }
    return JSON.stringify(obj);
  } catch (_) {
    return String(obj);
  }
}

let instance = null;
module.exports = {
  getLogger() {
    if (!instance) instance = new Logger();
    return instance;
  }
};
