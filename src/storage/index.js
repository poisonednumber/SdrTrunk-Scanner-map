'use strict';

const LocalStorage = require('./localStorage');
const S3Storage = require('./s3Storage');
const { createLogger } = require('../logger');

const log = createLogger('storage');

/**
 * Build a storage backend from environment variables.
 *
 * STORAGE_MODE: local | s3 | r2 | b2 | minio | db
 *   - "db" returns null here (caller keeps audio in SQLite, legacy path).
 *
 * @param {object} [env=process.env]
 * @returns {LocalStorage|S3Storage|null}
 */
function createStorage(env = process.env) {
  const mode = (env.STORAGE_MODE || 'local').toLowerCase();

  switch (mode) {
    case 'local':
      return new LocalStorage({
        dir: env.LOCAL_AUDIO_DIR || 'audio',
        publicBaseUrl: env.S3_PUBLIC_BASE_URL || null,
      });

    case 's3':
    case 'r2':
    case 'b2':
    case 'minio': {
      const forcePathStyle =
        mode === 'minio' ||
        String(env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';
      return new S3Storage({
        type: mode,
        endpoint: env.S3_ENDPOINT || undefined,
        region: env.S3_REGION || (mode === 's3' ? 'us-east-1' : 'auto'),
        bucket: env.S3_BUCKET_NAME,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle,
        publicBaseUrl: env.S3_PUBLIC_BASE_URL || null,
      });
    }

    case 'db':
      log.warn('STORAGE_MODE=db (legacy): audio stored as SQLite BLOBs. Consider local/r2/s3.');
      return null;

    default:
      log.warn(`Unknown STORAGE_MODE "${mode}", falling back to local.`);
      return new LocalStorage({ dir: env.LOCAL_AUDIO_DIR || 'audio' });
  }
}

function isDbMode(env = process.env) {
  return (env.STORAGE_MODE || 'local').toLowerCase() === 'db';
}

/** Build a date-partitioned object key, e.g. 2026/06/19/<name>. */
function buildKey(filename, date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${y}/${m}/${d}/${safe}`;
}

module.exports = { createStorage, isDbMode, buildKey, LocalStorage, S3Storage };
