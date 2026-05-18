const JOB_TYPES = {
  TRANSCRIPTION: 'transcription',
  ADDRESS_EXTRACTION: 'address_extraction',
  GEOCODING: 'geocoding',
  DISCORD_PUBLISH: 'discord_publish'
};

const JOB_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RETRYABLE: 'retryable'
};

function serializeJson(value) {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

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

async function createProcessingJob(db, {
  transcriptionId,
  jobType,
  payload = {},
  priority = 0,
  maxAttempts = 3,
  runAfter = null
}) {
  const result = await run(
    db,
    `INSERT INTO call_jobs (
      transcription_id, job_type, status, priority, max_attempts, run_after, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      transcriptionId,
      jobType,
      JOB_STATUS.PENDING,
      priority,
      maxAttempts,
      runAfter,
      serializeJson(payload)
    ]
  );

  return result.lastID;
}

async function markJobProcessing(db, jobId) {
  await run(
    db,
    `UPDATE call_jobs
     SET status = ?, attempts = attempts + 1, started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JOB_STATUS.PROCESSING, jobId]
  );
}

async function markJobCompleted(db, jobId, result = {}) {
  await run(
    db,
    `UPDATE call_jobs
     SET status = ?, result_json = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JOB_STATUS.COMPLETED, serializeJson(result), jobId]
  );
}

async function markJobFailed(db, jobId, error, { retryable = false } = {}) {
  const status = retryable ? JOB_STATUS.RETRYABLE : JOB_STATUS.FAILED;
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');

  await run(
    db,
    `UPDATE call_jobs
     SET status = ?, last_error = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, message, jobId]
  );
}

async function getJobById(db, jobId) {
  const row = await get(db, 'SELECT * FROM call_jobs WHERE id = ?', [jobId]);
  if (!row) return null;

  return {
    ...row,
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, null)
  };
}

module.exports = {
  JOB_STATUS,
  JOB_TYPES,
  createProcessingJob,
  getJobById,
  markJobCompleted,
  markJobFailed,
  markJobProcessing,
  parseJson,
  serializeJson
};
