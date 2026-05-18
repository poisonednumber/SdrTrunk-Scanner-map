const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JOB_STATUS,
  JOB_TYPES,
  parseJson,
  serializeJson
} = require('../src/jobs/processingJobs');

test('job constants define the first durable processing states', () => {
  assert.equal(JOB_TYPES.TRANSCRIPTION, 'transcription');
  assert.equal(JOB_STATUS.PENDING, 'pending');
  assert.equal(JOB_STATUS.PROCESSING, 'processing');
  assert.equal(JOB_STATUS.COMPLETED, 'completed');
});

test('serializeJson and parseJson preserve payload objects', () => {
  const payload = { transcriptionId: 42, mode: 'local' };
  assert.deepEqual(parseJson(serializeJson(payload)), payload);
});

test('parseJson returns fallback for invalid JSON', () => {
  assert.deepEqual(parseJson('{bad json', { ok: false }), { ok: false });
});
