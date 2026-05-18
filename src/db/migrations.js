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
        FOREIGN KEY(transcription_id) REFERENCES transcriptions(id)
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
