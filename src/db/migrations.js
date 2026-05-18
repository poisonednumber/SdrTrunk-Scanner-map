const BASE_MIGRATIONS = [
  {
    id: '001_create_core_tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS transcriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        talk_group_id TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        transcription TEXT,
        audio_file_path TEXT,
        address TEXT,
        lat REAL,
        lon REAL,
        category TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS global_keywords (
        keyword TEXT UNIQUE,
        talk_group_id TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS talk_groups (
        id TEXT PRIMARY KEY,
        hex TEXT,
        alpha_tag TEXT,
        mode TEXT,
        description TEXT,
        tag TEXT,
        county TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS frequencies (
        id INTEGER PRIMARY KEY,
        frequency TEXT,
        description TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS audio_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transcription_id INTEGER,
        audio_data BLOB,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(transcription_id) REFERENCES transcriptions(id) ON DELETE SET NULL
      )`
    ]
  },
  {
    id: '002_create_auth_tables',
    requires: ({ enableAuth }) => enableAuth,
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        ip_address TEXT,
        user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`
    ]
  },
  {
    id: '003_create_call_jobs',
    statements: [
      `CREATE TABLE IF NOT EXISTS call_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transcription_id INTEGER,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        priority INTEGER NOT NULL DEFAULT 0,
        run_after DATETIME,
        payload_json TEXT,
        result_json TEXT,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        FOREIGN KEY(transcription_id) REFERENCES transcriptions(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_call_jobs_status_priority ON call_jobs (status, priority DESC, created_at ASC)`,
      `CREATE INDEX IF NOT EXISTS idx_call_jobs_transcription_type ON call_jobs (transcription_id, job_type)`
    ]
  },
  {
    id: '004_create_app_settings',
    statements: [
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        is_secret INTEGER NOT NULL DEFAULT 0,
        requires_restart INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS setup_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS settings_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        setting_key TEXT,
        actor TEXT,
        details_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ]
  }
];

function getMigrationPlan(options = {}) {
  return BASE_MIGRATIONS.filter((migration) => {
    if (!migration.requires) return true;
    return migration.requires(options);
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
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

async function applyMigrations(db, options = {}) {
  await run(db, `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const appliedRows = await all(db, 'SELECT id FROM schema_migrations');
  const applied = new Set(appliedRows.map((row) => row.id));
  const appliedNow = [];

  for (const migration of getMigrationPlan(options)) {
    if (applied.has(migration.id)) continue;

    for (const statement of migration.statements) {
      await run(db, statement);
    }

    await run(db, 'INSERT INTO schema_migrations (id) VALUES (?)', [migration.id]);
    appliedNow.push(migration.id);
  }

  return appliedNow;
}

module.exports = {
  BASE_MIGRATIONS,
  applyMigrations,
  getMigrationPlan
};
