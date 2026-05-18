const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JOB_STATUS,
  JOB_TYPES,
  getRecentJobs,
  getJobSummary,
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

test('getJobSummary groups rows by job type and status', async () => {
  const rows = [
    { job_type: JOB_TYPES.TRANSCRIPTION, status: JOB_STATUS.PENDING, count: 2 },
    { job_type: JOB_TYPES.TRANSCRIPTION, status: JOB_STATUS.COMPLETED, count: 1 }
  ];
  const db = {
    all(sql, params, callback) {
      callback(null, rows);
    }
  };

  const summary = await getJobSummary(db);

  assert.equal(summary.totals.transcription.pending, 2);
  assert.equal(summary.totals.transcription.completed, 1);
  assert.deepEqual(summary.rows, rows);
});

test('getRecentJobs clamps limit and parses payload/result JSON', async () => {
  const db = {
    all(sql, params, callback) {
      assert.equal(params.at(-1), 200);
      callback(null, [{
        id: 7,
        transcription_id: 42,
        job_type: JOB_TYPES.TRANSCRIPTION,
        status: JOB_STATUS.COMPLETED,
        payload_json: '{"mode":"local"}',
        result_json: '{"empty":false}'
      }]);
    }
  };

  const jobs = await getRecentJobs(db, { limit: 999 });

  assert.equal(jobs[0].id, 7);
  assert.deepEqual(jobs[0].payload, { mode: 'local' });
  assert.deepEqual(jobs[0].result, { empty: false });
});
