const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, parseBoolean, parseList, redactConfig } = require('../src/config');

test('parseBoolean accepts common truthy values', () => {
  assert.equal(parseBoolean('true'), true);
  assert.equal(parseBoolean('1'), true);
  assert.equal(parseBoolean('yes'), true);
  assert.equal(parseBoolean('false'), false);
});

test('parseList trims and drops empty entries', () => {
  assert.deepEqual(parseList('1001, 1002, ,2001'), ['1001', '1002', '2001']);
});

test('loadConfig reports conditional validation errors together', () => {
  const result = loadConfig({
    STORAGE_MODE: 's3',
    AI_PROVIDER: 'openai',
    TRANSCRIPTION_MODE: 'remote'
  });

  assert.equal(result.isValid, false);
  assert.deepEqual(
    result.errors.map((error) => error.key),
    ['S3_ENDPOINT', 'S3_BUCKET_NAME', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'FASTER_WHISPER_SERVER_URL']
  );
});

test('redactConfig hides secret values', () => {
  const redacted = redactConfig({
    discordToken: 'secret',
    openaiApiKey: 'secret',
    publicDomain: 'localhost'
  });

  assert.equal(redacted.discordToken, '[redacted]');
  assert.equal(redacted.openaiApiKey, '[redacted]');
  assert.equal(redacted.publicDomain, 'localhost');
});
