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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
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

async function getJobSummary(db) {
  const rows = await all(
    db,
    `SELECT job_type, status, COUNT(*) AS count
     FROM call_jobs
     GROUP BY job_type, status
     ORDER BY job_type ASC, status ASC`
  );

  const totals = {};
  for (const row of rows) {
    if (!totals[row.job_type]) totals[row.job_type] = {};
    totals[row.job_type][row.status] = row.count;
  }

  return {
    totals,
    rows
  };
}

async function getRecentJobs(db, { limit = 50, status, jobType } = {}) {
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  const where = [];
  const params = [];

  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  if (jobType) {
    where.push('job_type = ?');
    params.push(jobType);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await all(
    db,
    `SELECT id, transcription_id, job_type, status, attempts, max_attempts, priority,
            run_after, payload_json, result_json, last_error, created_at, updated_at,
            started_at, completed_at
     FROM call_jobs
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT ?`,
    [...params, safeLimit]
  );

  return rows.map((row) => ({
    ...row,
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, null)
  }));
}

module.exports = {
  JOB_STATUS,
  JOB_TYPES,
  createProcessingJob,
  getJobById,
  getJobSummary,
  getRecentJobs,
  markJobCompleted,
  markJobFailed,
  markJobProcessing,
  parseJson,
  serializeJson
};
