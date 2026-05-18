const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SETTING_DEFINITIONS = {
  publicDomain: { envKey: 'PUBLIC_DOMAIN', defaultValue: 'localhost', requiresRestart: true },
  timezone: { envKey: 'TIMEZONE', defaultValue: 'US/Eastern', requiresRestart: false },
  storageMode: { envKey: 'STORAGE_MODE', defaultValue: 'local', requiresRestart: true },
  s3Endpoint: { envKey: 'S3_ENDPOINT', defaultValue: '', requiresRestart: true },
  s3BucketName: { envKey: 'S3_BUCKET_NAME', defaultValue: '', requiresRestart: true },
  transcriptionMode: { envKey: 'TRANSCRIPTION_MODE', defaultValue: 'local', requiresRestart: true },
  transcriptionDevice: { envKey: 'TRANSCRIPTION_DEVICE', defaultValue: 'cpu', requiresRestart: true },
  aiProvider: { envKey: 'AI_PROVIDER', defaultValue: 'ollama', requiresRestart: false },
  ollamaUrl: { envKey: 'OLLAMA_URL', defaultValue: 'http://localhost:11434', requiresRestart: false },
  ollamaModel: { envKey: 'OLLAMA_MODEL', defaultValue: 'llama3.1:8b', requiresRestart: false },
  openaiModel: { envKey: 'OPENAI_MODEL', defaultValue: 'gpt-4o-mini', requiresRestart: false },
  fasterWhisperServerUrl: { envKey: 'FASTER_WHISPER_SERVER_URL', defaultValue: '', requiresRestart: false },
  whisperModel: { envKey: 'WHISPER_MODEL', defaultValue: 'large-v3', requiresRestart: false },
  openaiTranscriptionPrompt: { envKey: 'OPENAI_TRANSCRIPTION_PROMPT', defaultValue: '', requiresRestart: false },
  openaiTranscriptionModel: { envKey: 'OPENAI_TRANSCRIPTION_MODEL', defaultValue: 'whisper-1', requiresRestart: false },
  openaiTranscriptionTemperature: { envKey: 'OPENAI_TRANSCRIPTION_TEMPERATURE', defaultValue: '0.0', requiresRestart: false },
  icadUrl: { envKey: 'ICAD_URL', defaultValue: '', requiresRestart: false },
  icadProfile: { envKey: 'ICAD_PROFILE', defaultValue: 'whisper-1', requiresRestart: false },
  mappedTalkGroups: { envKey: 'MAPPED_TALK_GROUPS', defaultValue: '', requiresRestart: false },
  enableMappedTalkGroups: { envKey: 'ENABLE_MAPPED_TALK_GROUPS', defaultValue: 'true', requiresRestart: false },
  summaryLookbackHours: { envKey: 'SUMMARY_LOOKBACK_HOURS', defaultValue: '1', requiresRestart: false },
  askAiLookbackHours: { envKey: 'ASK_AI_LOOKBACK_HOURS', defaultValue: '8', requiresRestart: false },
  maxConcurrentTranscriptions: { envKey: 'MAX_CONCURRENT_TRANSCRIPTIONS', defaultValue: '3', requiresRestart: true }
};

const SECRET_DEFINITIONS = {
  discordToken: { envKey: 'DISCORD_TOKEN', requiresRestart: true },
  googleMapsApiKey: { envKey: 'GOOGLE_MAPS_API_KEY', requiresRestart: false },
  locationIqApiKey: { envKey: 'LOCATIONIQ_API_KEY', requiresRestart: false },
  openaiApiKey: { envKey: 'OPENAI_API_KEY', requiresRestart: false },
  icadApiKey: { envKey: 'ICAD_API_KEY', requiresRestart: false },
  s3AccessKeyId: { envKey: 'S3_ACCESS_KEY_ID', requiresRestart: true },
  s3SecretAccessKey: { envKey: 'S3_SECRET_ACCESS_KEY', requiresRestart: true },
  webserverPassword: { envKey: 'WEBSERVER_PASSWORD', requiresRestart: true },
  uploadApiKey: { envKey: 'SCANNER_MAP_UPLOAD_API_KEY', requiresRestart: false }
};

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecret(plainText, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  });
}

function decryptSecret(payload, secret) {
  const parsed = JSON.parse(payload);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function getInstanceSecret(options = {}) {
  if (options.env && options.env.SETTINGS_ENCRYPTION_KEY) {
    return options.env.SETTINGS_ENCRYPTION_KEY;
  }

  const dataDir = options.dataDir || path.join(__dirname, '..', '..', 'data');
  const secretPath = options.secretPath || path.join(dataDir, 'instance-secret.key');
  fs.mkdirSync(dataDir, { recursive: true });

  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }

  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}

async function audit(db, eventType, settingKey, details = {}, actor = 'system') {
  await run(
    db,
    'INSERT INTO settings_audit_events (event_type, setting_key, actor, details_json) VALUES (?, ?, ?, ?)',
    [eventType, settingKey || null, actor, JSON.stringify(details)]
  );
}

async function getStoredSettings(db) {
  const rows = await all(db, 'SELECT key, value, is_secret, requires_restart, updated_at FROM app_settings ORDER BY key');
  const settings = {};
  const secrets = {};

  for (const row of rows) {
    if (row.is_secret) {
      secrets[row.key] = {
        configured: Boolean(row.value),
        source: 'sqlite',
        requiresRestart: Boolean(row.requires_restart),
        updatedAt: row.updated_at
      };
    } else {
      settings[row.key] = {
        value: row.value,
        source: 'sqlite',
        requiresRestart: Boolean(row.requires_restart),
        updatedAt: row.updated_at
      };
    }
  }

  return { settings, secrets };
}

async function resolveSettings(db, env = process.env) {
  const stored = await getStoredSettings(db);
  const settings = {};

  for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
    const storedValue = stored.settings[key];
    if (storedValue) {
      settings[key] = storedValue;
    } else if (env[definition.envKey] !== undefined && env[definition.envKey] !== '') {
      settings[key] = {
        value: env[definition.envKey],
        source: 'env',
        requiresRestart: definition.requiresRestart
      };
    } else {
      settings[key] = {
        value: definition.defaultValue,
        source: 'default',
        requiresRestart: definition.requiresRestart
      };
    }
  }

  const secrets = {};
  for (const [key, definition] of Object.entries(SECRET_DEFINITIONS)) {
    const storedSecret = stored.secrets[key];
    secrets[key] = storedSecret || {
      configured: Boolean(env[definition.envKey]),
      source: env[definition.envKey] ? 'env' : 'missing',
      requiresRestart: definition.requiresRestart
    };
  }

  return { settings, secrets };
}

async function getRuntimeSetting(db, key, env = process.env) {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) return undefined;

  const row = await get(db, 'SELECT value FROM app_settings WHERE key = ? AND is_secret = 0', [key]);
  if (row && row.value !== undefined && row.value !== null) return row.value;
  if (env[definition.envKey] !== undefined && env[definition.envKey] !== '') return env[definition.envKey];
  return definition.defaultValue;
}

async function getRuntimeSecret(db, key, options = {}) {
  const definition = SECRET_DEFINITIONS[key];
  if (!definition) return undefined;

  const env = options.env || process.env;
  const row = await get(db, 'SELECT value FROM app_settings WHERE key = ? AND is_secret = 1', [key]);
  if (row && row.value) {
    const instanceSecret = getInstanceSecret({ env });
    return decryptSecret(row.value, instanceSecret);
  }

  return env[definition.envKey] || '';
}

async function getRuntimeConfig(db, env = process.env) {
  const settings = {};
  const secrets = {};

  for (const key of Object.keys(SETTING_DEFINITIONS)) {
    settings[key] = await getRuntimeSetting(db, key, env);
  }

  for (const key of Object.keys(SECRET_DEFINITIONS)) {
    secrets[key] = await getRuntimeSecret(db, key, { env });
  }

  return { settings, secrets };
}

async function saveSettings(db, values, actor = 'admin') {
  const results = {};

  for (const [key, value] of Object.entries(values || {})) {
    const definition = SETTING_DEFINITIONS[key];
    if (!definition) {
      results[key] = { ok: false, error: 'Unknown setting' };
      continue;
    }

    await run(
      db,
      `INSERT INTO app_settings (key, value, is_secret, requires_restart, updated_at)
       VALUES (?, ?, 0, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = 0,
         requires_restart = excluded.requires_restart, updated_at = CURRENT_TIMESTAMP`,
      [key, String(value), definition.requiresRestart ? 1 : 0]
    );
    await audit(db, 'setting_updated', key, { requiresRestart: definition.requiresRestart }, actor);
    results[key] = { ok: true, requiresRestart: definition.requiresRestart };
  }

  return results;
}

async function saveSecret(db, key, value, options = {}) {
  const definition = SECRET_DEFINITIONS[key];
  if (!definition) {
    return { ok: false, error: 'Unknown secret' };
  }

  if (!value) {
    return { ok: false, error: 'Secret value is required' };
  }

  const instanceSecret = getInstanceSecret({ env: options.env || process.env });
  await run(
    db,
    `INSERT INTO app_settings (key, value, is_secret, requires_restart, updated_at)
     VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = 1,
       requires_restart = excluded.requires_restart, updated_at = CURRENT_TIMESTAMP`,
    [key, encryptSecret(value, instanceSecret), definition.requiresRestart ? 1 : 0]
  );
  await audit(db, 'secret_updated', key, { requiresRestart: definition.requiresRestart }, options.actor || 'admin');

  return { ok: true, configured: true, requiresRestart: definition.requiresRestart };
}

async function getSetupStatus(db, env = process.env) {
  const resolved = await resolveSettings(db, env);
  const setupRow = await get(db, 'SELECT value FROM setup_state WHERE key = ?', ['setup_complete']);
  const adminRow = await get(db, 'SELECT COUNT(*) AS count FROM users WHERE username = ?', ['admin']).catch(() => ({ count: 0 }));

  const hasGeocoding = resolved.secrets.googleMapsApiKey.configured || resolved.secrets.locationIqApiKey.configured;
  const missing = [];
  if (!adminRow || adminRow.count === 0) missing.push('adminAccount');
  if (!resolved.secrets.uploadApiKey.configured) missing.push('uploadApiKey');
  if (!hasGeocoding) missing.push('geocodingProvider');
  if (!resolved.settings.transcriptionMode.value) missing.push('transcriptionMode');
  if (!resolved.settings.storageMode.value) missing.push('storageMode');

  return {
    setupRequired: setupRow?.value !== 'true' || missing.length > 0,
    setupComplete: setupRow?.value === 'true' && missing.length === 0,
    missing,
    checks: {
      adminAccount: Boolean(adminRow && adminRow.count > 0),
      uploadApiKey: resolved.secrets.uploadApiKey.configured,
      geocodingProvider: hasGeocoding,
      transcriptionMode: Boolean(resolved.settings.transcriptionMode.value),
      storageMode: Boolean(resolved.settings.storageMode.value)
    },
    settings: resolved.settings,
    secrets: resolved.secrets
  };
}

async function markSetupComplete(db, actor = 'admin') {
  await run(
    db,
    `INSERT INTO setup_state (key, value, updated_at)
     VALUES ('setup_complete', 'true', CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = CURRENT_TIMESTAMP`
  );
  await audit(db, 'setup_completed', 'setup_complete', {}, actor);
}

module.exports = {
  SECRET_DEFINITIONS,
  SETTING_DEFINITIONS,
  decryptSecret,
  encryptSecret,
  getInstanceSecret,
  getRuntimeConfig,
  getRuntimeSecret,
  getRuntimeSetting,
  getSetupStatus,
  resolveSettings,
  saveSecret,
  saveSettings,
  markSetupComplete
};
