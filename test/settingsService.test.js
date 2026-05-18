const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decryptSecret,
  encryptSecret,
  getRuntimeConfig,
  getRuntimeSecret,
  getRuntimeSetting,
  getSetupStatus,
  resolveSettings
} = require('../src/settings/settingsService');

function createFakeDb({ settingsRows = [], setupComplete = false, adminCount = 0 } = {}) {
  return {
    all(sql, params, callback) {
      callback(null, settingsRows);
    },
    get(sql, params, callback) {
      if (sql.includes('app_settings')) {
        callback(null, settingsRows.find((row) => row.key === params[0]));
        return;
      }
      if (sql.includes('setup_state')) {
        callback(null, setupComplete ? { value: 'true' } : undefined);
        return;
      }
      if (sql.includes('COUNT(*) AS count FROM users')) {
        callback(null, { count: adminCount });
        return;
      }
      callback(null, undefined);
    }
  };
}

test('resolveSettings prefers SQLite settings over env and defaults', async () => {
  const db = createFakeDb({
    settingsRows: [
      { key: 'timezone', value: 'America/Chicago', is_secret: 0, requires_restart: 0, updated_at: 'now' }
    ]
  });

  const resolved = await resolveSettings(db, {
    TIMEZONE: 'US/Eastern',
    PUBLIC_DOMAIN: 'scanner.example'
  });

  assert.equal(resolved.settings.timezone.value, 'America/Chicago');
  assert.equal(resolved.settings.timezone.source, 'sqlite');
  assert.equal(resolved.settings.publicDomain.value, 'scanner.example');
  assert.equal(resolved.settings.publicDomain.source, 'env');
  assert.equal(resolved.settings.storageMode.value, 'local');
  assert.equal(resolved.settings.storageMode.source, 'default');
});

test('runtime setting reads SQLite before env before default', async () => {
  const db = createFakeDb({
    settingsRows: [
      { key: 'storageMode', value: 's3', is_secret: 0, requires_restart: 1, updated_at: 'now' }
    ]
  });

  assert.equal(await getRuntimeSetting(db, 'storageMode', { STORAGE_MODE: 'local' }), 's3');
  assert.equal(await getRuntimeSetting(createFakeDb(), 'storageMode', { STORAGE_MODE: 'local' }), 'local');
  assert.equal(await getRuntimeSetting(createFakeDb(), 'storageMode', {}), 'local');
});

test('runtime secret decrypts SQLite values before env fallback', async () => {
  const secret = 'test-instance-secret';
  const encrypted = encryptSecret('stored-openai-key', secret);
  const db = createFakeDb({
    settingsRows: [
      { key: 'openaiApiKey', value: encrypted, is_secret: 1, requires_restart: 0, updated_at: 'now' }
    ]
  });

  const value = await getRuntimeSecret(db, 'openaiApiKey', {
    env: {
      SETTINGS_ENCRYPTION_KEY: secret,
      OPENAI_API_KEY: 'env-openai-key'
    }
  });

  assert.equal(value, 'stored-openai-key');
  assert.equal(await getRuntimeSecret(createFakeDb(), 'openaiApiKey', { env: { OPENAI_API_KEY: 'env-key' } }), 'env-key');
});

test('runtime config includes resolved settings and decrypted secrets', async () => {
  const db = createFakeDb({
    settingsRows: [
      { key: 'timezone', value: 'America/Chicago', is_secret: 0, requires_restart: 0, updated_at: 'now' }
    ]
  });

  const config = await getRuntimeConfig(db, { OPENAI_API_KEY: 'env-key' });

  assert.equal(config.settings.timezone, 'America/Chicago');
  assert.equal(config.secrets.openaiApiKey, 'env-key');
});

test('resolveSettings redacts write-only secret values', async () => {
  const db = createFakeDb({
    settingsRows: [
      { key: 'openaiApiKey', value: 'encrypted-payload', is_secret: 1, requires_restart: 0, updated_at: 'now' }
    ]
  });

  const resolved = await resolveSettings(db, {});

  assert.equal(resolved.secrets.openaiApiKey.configured, true);
  assert.equal(resolved.secrets.openaiApiKey.source, 'sqlite');
  assert.equal(Object.hasOwn(resolved.secrets.openaiApiKey, 'value'), false);
});

test('encryptSecret and decryptSecret round trip secret values', () => {
  const secret = 'local-instance-secret';
  const encrypted = encryptSecret('api-key-value', secret);

  assert.notEqual(encrypted, 'api-key-value');
  assert.equal(decryptSecret(encrypted, secret), 'api-key-value');
});

test('getSetupStatus reports incomplete setup requirements', async () => {
  const db = createFakeDb({ setupComplete: false, adminCount: 0 });
  const status = await getSetupStatus(db, {});

  assert.equal(status.setupRequired, true);
  assert.equal(status.setupComplete, false);
  assert.ok(status.missing.includes('adminAccount'));
  assert.ok(status.missing.includes('uploadApiKey'));
  assert.ok(status.missing.includes('geocodingProvider'));
});

test('getSetupStatus accepts configured essentials', async () => {
  const db = createFakeDb({
    setupComplete: true,
    adminCount: 1,
    settingsRows: [
      { key: 'uploadApiKey', value: 'encrypted', is_secret: 1, requires_restart: 0, updated_at: 'now' },
      { key: 'googleMapsApiKey', value: 'encrypted', is_secret: 1, requires_restart: 0, updated_at: 'now' },
      { key: 'transcriptionMode', value: 'local', is_secret: 0, requires_restart: 1, updated_at: 'now' },
      { key: 'storageMode', value: 'local', is_secret: 0, requires_restart: 1, updated_at: 'now' }
    ]
  });

  const status = await getSetupStatus(db, {});

  assert.equal(status.setupRequired, false);
  assert.equal(status.setupComplete, true);
  assert.deepEqual(status.missing, []);
});
