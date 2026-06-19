'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createLogger } = require('../logger');

const log = createLogger('storage:local');

/**
 * Local filesystem storage backend.
 * Audio files are stored under LOCAL_AUDIO_DIR (default ./audio).
 */
class LocalStorage {
  constructor(opts = {}) {
    this.baseDir = path.isAbsolute(opts.dir || '')
      ? opts.dir
      : path.join(process.cwd(), opts.dir || 'audio');
    this.publicBaseUrl = opts.publicBaseUrl || null;
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.type = 'local';
  }

  _resolve(key) {
    // Prevent path traversal: normalize and ensure the result stays inside baseDir.
    const safeKey = path.normalize(key).replace(/^(\.\.([/\\]|$))+/, '');
    const full = path.join(this.baseDir, safeKey);
    if (!full.startsWith(this.baseDir)) {
      throw new Error('Invalid storage key (path traversal blocked)');
    }
    return full;
  }

  /**
   * @param {string} key relative object key, e.g. "2026/01/call_123.mp3"
   * @param {Buffer} buffer
   * @param {string} contentType
   * @returns {Promise<{key:string, url:string|null}>}
   */
  async save(key, buffer, _contentType = 'audio/mpeg') {
    // Local FS doesn't track content type; param kept for interface parity with S3.
    const full = this._resolve(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer);
    log.debug(`saved ${key} (${buffer.length} bytes)`);
    return { key, url: this.publicUrl(key) };
  }

  async exists(key) {
    try {
      await fsp.access(this._resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async getBuffer(key) {
    return fsp.readFile(this._resolve(key));
  }

  /** Returns a readable stream for the object (used to pipe to HTTP responses). */
  createReadStream(key) {
    return fs.createReadStream(this._resolve(key));
  }

  async delete(key) {
    try {
      await fsp.unlink(this._resolve(key));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  publicUrl(key) {
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${key}`;
    }
    return null; // served via the app's /audio route
  }

  async testConnection() {
    const probe = `.healthcheck-${Date.now()}`;
    await this.save(probe, Buffer.from('ok'));
    await this.delete(probe);
    return { ok: true, type: this.type, location: this.baseDir };
  }
}

module.exports = LocalStorage;
