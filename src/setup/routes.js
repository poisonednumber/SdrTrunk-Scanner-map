'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { Readable } = require('stream');
const fetch = require('node-fetch');
const multer = require('multer');
const csv = require('csv-parser');
const { createLogger } = require('../logger');
const { createStorage } = require('../storage');
const envFile = require('./envFile');
const apiKeys = require('./apiKeys');
const pythonEnv = require('./pythonEnv');
const geoHelpers = require('./geoHelpers');
const maintenance = require('./maintenance');

// Proxy a request to the bot process's localhost-only internal API (where the
// Discord client lives). The bot and webserver are separate processes.
async function botProxy(pathname, method = 'GET', body = null) {
  const port = process.env.BOT_PORT || '3306';
  const url = `http://127.0.0.1:${port}${pathname}`;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      timeout: 60000,
    });
    return await r.json();
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach the bot process on port ${port}. Discord tools only work when the full app is running. `
        + `If you're still in first-time setup, finish the wizard, then restart with "node start.js". `
        + `Also make sure Discord isn't disabled (MAP_ONLY_MODE) and the bot started without errors.`,
    };
  }
}

const log = createLogger('setup');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const NON_SECRET_KEYS = [
  'SETUP_COMPLETE', 'MAP_ONLY_MODE', 'BOT_PORT', 'WEBSERVER_PORT', 'PUBLIC_DOMAIN', 'TIMEZONE',
  'ENABLE_AUTH', 'STORAGE_MODE', 'LOCAL_AUDIO_DIR', 'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET_NAME',
  'S3_FORCE_PATH_STYLE', 'S3_PUBLIC_BASE_URL', 'AUDIO_RETENTION_DAYS', 'GEOCODING_CITY',
  'GEOCODING_STATE', 'GEOCODING_COUNTRY', 'GEOCODING_TARGET_COUNTIES', 'TARGET_CITIES_LIST',
  'MAP_CENTER_LAT', 'MAP_CENTER_LON', 'MAP_DEFAULT_ZOOM',
  'TRANSCRIPTION_MODE', 'TRANSCRIPTION_DEVICE', 'WHISPER_MODEL', 'FASTER_WHISPER_SERVER_URL',
  'ICAD_URL', 'ICAD_PROFILE', 'OPENAI_TRANSCRIPTION_MODEL', 'AI_PROVIDER', 'OLLAMA_URL',
  'OLLAMA_MODEL', 'OPENAI_MODEL', 'SUMMARY_LOOKBACK_HOURS', 'ASK_AI_LOOKBACK_HOURS',
  'ENABLE_MAPPED_TALK_GROUPS', 'MAPPED_TALK_GROUPS', 'ENABLE_TWO_TONE_MODE', 'TWO_TONE_TALK_GROUPS',
  'TONE_DETECTION_TYPE', 'PYTHON_COMMAND', 'OPENAI_TRANSCRIPTION_MODEL', 'OPENAI_TRANSCRIPTION_PROMPT',
  'SUMMARY_LOOKBACK_HOURS', 'ASK_AI_LOOKBACK_HOURS',
  // AI summary scoping (which talkgroups appear in the dispatch-summary channel)
  'ENABLE_SUMMARY_TALK_GROUPS', 'SUMMARY_TALK_GROUPS',
  // Transcription filtering (lets TrunkRecorder users skip transcribing certain TGs)
  'TRANSCRIBE_MODE', 'TRANSCRIBE_TALK_GROUPS',
  'MAX_CONCURRENT_TRANSCRIPTIONS', 'AUTO_UPDATE',
];

/** Keys that hold secrets - we report only whether they are set, never the value. */
const SECRET_KEYS = [
  'DISCORD_TOKEN', 'CLIENT_ID', 'WEBSERVER_PASSWORD', 'SESSION_SECRET', 'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY', 'GOOGLE_MAPS_API_KEY', 'LOCATIONIQ_API_KEY', 'OPENAI_API_KEY',
  'ICAD_API_KEY',
];

function safeStatus() {
  const values = envFile.readValues();
  const out = { config: {}, secretsSet: {} };
  for (const k of NON_SECRET_KEYS) out.config[k] = values[k] ?? '';
  for (const k of SECRET_KEYS) out.secretsSet[k] = !!(values[k] && values[k].trim());
  out.setupComplete = envFile.isSetupComplete();
  // When launched via start.bat/start.sh we can self-restart into the full app
  // after setup, so the wizard can offer a one-click "Start Scanner Map".
  out.launcher = !!process.env.SCANNER_LAUNCHER;
  return out;
}

function checkCommand(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 });
    if (r.error) return { ok: false, error: r.error.message };
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return { ok: r.status === 0, version: text.split(/\r?\n/)[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function runHealthChecks() {
  const pythonCmd = process.env.PYTHON_COMMAND || envFile.readValues().PYTHON_COMMAND || 'python';
  const dataDir = path.join(process.cwd(), 'data');
  let dbWritable = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.probe-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    dbWritable = true;
  } catch (_) {
    dbWritable = false;
  }

  return {
    node: { ok: true, version: process.version },
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    cpus: os.cpus().length,
    memoryGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    python: checkCommand(pythonCmd, ['--version']),
    ffmpeg: checkCommand('ffmpeg', ['-version']),
    diskWritable: dbWritable,
  };
}

async function testGeocoding({ provider, key }) {
  if (!key) return { ok: false, error: 'No API key provided' };
  const q = '1600 Amphitheatre Parkway, Mountain View, CA';
  try {
    if (provider === 'google') {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${key}`;
      const r = await fetch(url, { timeout: 10000 });
      const j = await r.json();
      if (j.status === 'OK') return { ok: true, sample: j.results[0]?.formatted_address };
      return { ok: false, error: j.error_message || j.status };
    }
    // locationiq
    const url = `https://us1.locationiq.com/v1/search?key=${key}&q=${encodeURIComponent(q)}&format=json&limit=1`;
    const r = await fetch(url, { timeout: 10000 });
    if (r.status === 401) return { ok: false, error: 'Invalid LocationIQ key' };
    const j = await r.json();
    if (Array.isArray(j) && j.length) return { ok: true, sample: j[0].display_name };
    return { ok: false, error: j.error || 'No result' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function testOpenAI({ key }) {
  if (!key) return { ok: false, error: 'No API key provided' };
  try {
    const r = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 10000,
    });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => ({}));
    return { ok: false, error: j.error?.message || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function testOllama({ url }) {
  const base = url || 'http://localhost:11434';
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/api/tags`, { timeout: 8000 });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    return { ok: true, models: (j.models || []).map((m) => m.name) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function testDiscord({ token }) {
  if (!token) return { ok: false, error: 'No token provided' };
  try {
    const r = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      timeout: 10000,
    });
    if (r.ok) {
      const j = await r.json();
      return { ok: true, botName: `${j.username}#${j.discriminator}`, id: j.id };
    }
    return { ok: false, error: `Invalid token (HTTP ${r.status})` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function testStorage(body) {
  try {
    const env = {
      STORAGE_MODE: body.STORAGE_MODE,
      LOCAL_AUDIO_DIR: body.LOCAL_AUDIO_DIR,
      S3_ENDPOINT: body.S3_ENDPOINT,
      S3_REGION: body.S3_REGION,
      S3_BUCKET_NAME: body.S3_BUCKET_NAME,
      S3_ACCESS_KEY_ID: body.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: body.S3_SECRET_ACCESS_KEY,
      S3_FORCE_PATH_STYLE: body.S3_FORCE_PATH_STYLE,
      S3_PUBLIC_BASE_URL: body.S3_PUBLIC_BASE_URL,
    };
    // If testing an S3 family but a secret is blank, fall back to the stored one.
    const stored = envFile.readValues();
    if (!env.S3_ACCESS_KEY_ID) env.S3_ACCESS_KEY_ID = stored.S3_ACCESS_KEY_ID;
    if (!env.S3_SECRET_ACCESS_KEY) env.S3_SECRET_ACCESS_KEY = stored.S3_SECRET_ACCESS_KEY;

    const storage = createStorage(env);
    if (!storage) return { ok: true, note: 'DB storage mode needs no connection test' };
    const result = await storage.testConnection();
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Normalize a system label so imported talkgroups match incoming call labels
// (bot.js stores the same normalized value on each transcription).
function normalizeSystem(s) {
  return String(s || '').trim().toLowerCase();
}

function importTalkgroupsFromBuffer(db, buffer, system = '') {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('Database not available'));
    const sys = normalizeSystem(system);
    const rows = [];
    Readable.from(buffer)
      .pipe(csv({ headers: ['DEC', 'HEX', 'Alpha Tag', 'Mode', 'Description', 'Tag', 'County'], skipLines: 0 }))
      .on('data', (row) => rows.push(row))
      .on('error', reject)
      .on('end', () => {
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          // Keyed by (system, id): the same talkgroup id can exist in several
          // systems without overwriting each other.
          const stmt = db.prepare(
            `INSERT OR REPLACE INTO talk_groups (id, system, hex, alpha_tag, mode, description, tag, county)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
          let count = 0;
          for (const row of rows) {
            const id = String(row.DEC || '').trim();
            if (!id || isNaN(parseInt(id, 10))) continue; // skip header / bad rows
            stmt.run([id, sys, row.HEX, row['Alpha Tag'], row.Mode, row.Description, row.Tag, row.County]);
            count += 1;
          }
          stmt.finalize();
          db.run('COMMIT', (err) => {
            if (err) return reject(err);
            resolve({ count, system: sys, sample: rows.slice(0, 5) });
          });
        });
      });
  });
}

/**
 * Mount the setup wizard routes.
 * @param {import('express').Express} app
 * @param {{ getDb?: () => any }} [deps]
 */
function mountSetup(app, deps = {}) {
  const getDb = deps.getDb || (() => null);

  app.get('/api/setup/status', (req, res) => res.json(safeStatus()));
  app.get('/api/setup/health', async (req, res) => res.json(await runHealthChecks()));

  app.post('/api/setup/test/geocoding', async (req, res) => res.json(await testGeocoding(req.body || {})));
  app.post('/api/setup/test/openai', async (req, res) => res.json(await testOpenAI(req.body || {})));
  app.post('/api/setup/test/ollama', async (req, res) => res.json(await testOllama(req.body || {})));
  app.post('/api/setup/test/discord', async (req, res) => res.json(await testDiscord(req.body || {})));
  app.post('/api/setup/test/storage', async (req, res) => res.json(await testStorage(req.body || {})));

  // Accept one OR many CSV files (field name "file" or "files").
  app.post('/api/setup/upload-talkgroups', upload.array('files', 20), async (req, res) => {
    try {
      let files = req.files || [];
      if (!files.length && req.file) files = [req.file];
      if (!files.length) return res.status(400).json({ ok: false, error: 'No file(s) uploaded' });
      // System label for this batch (must match what the radio source sends as
      // its system label). Empty = legacy single-system / "all systems".
      const system = (req.body && req.body.system) || '';
      let total = 0;
      const perFile = [];
      for (const f of files) {
        const result = await importTalkgroupsFromBuffer(getDb(), f.buffer, system);
        total += result.count;
        perFile.push({ name: f.originalname, count: result.count });
      }
      log.info(`imported ${total} talkgroups from ${files.length} file(s) for system "${normalizeSystem(system) || '(default)'}" via setup wizard`);
      res.json({ ok: true, count: total, system: normalizeSystem(system), files: perFile });
    } catch (e) {
      log.error(`talkgroup import failed: ${e.message}`);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Some browsers send a single file under "file"; keep that working too.
  app.post('/api/setup/upload-talkgroup', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
      const system = (req.body && req.body.system) || '';
      const result = await importTalkgroupsFromBuffer(getDb(), req.file.buffer, system);
      res.json({ ok: true, count: result.count, system: normalizeSystem(system) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/setup/talkgroups', (req, res) => {
    const db = getDb();
    if (!db) return res.json({ talkgroups: [], total: 0 });
    const search = (req.query.search || '').toString().trim();
    const county = (req.query.county || '').toString().trim();
    const system = (req.query.system || '').toString().trim().toLowerCase();
    const sort = (req.query.sort || 'id').toString();
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 10000);

    const sortCol = { id: 'CAST(id AS INTEGER)', alpha: 'alpha_tag', county: 'county', tag: 'tag', system: 'system' }[sort] || 'CAST(id AS INTEGER)';
    const where = [];
    const params = [];
    if (search) {
      where.push('(alpha_tag LIKE ? OR description LIKE ? OR tag LIKE ? OR id LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (county) { where.push('county = ?'); params.push(county); }
    if (system) { where.push('system = ?'); params.push(system); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    db.all(`SELECT COUNT(*) AS n FROM talk_groups ${whereSql}`, params, (cerrr, crows) => {
      const total = crows && crows[0] ? crows[0].n : 0;
      db.all(
        `SELECT id, system, alpha_tag, description, tag, county FROM talk_groups ${whereSql} ORDER BY ${sortCol} LIMIT ?`,
        [...params, limit],
        (err, rows) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ talkgroups: rows || [], total });
        }
      );
    });
  });

  // Distinct counties (for the talkgroup filter dropdown).
  app.get('/api/setup/talkgroup-counties', (req, res) => {
    const db = getDb();
    if (!db) return res.json({ counties: [] });
    db.all(
      `SELECT DISTINCT county FROM talk_groups WHERE county IS NOT NULL AND county != '' ORDER BY county`,
      (err, rows) => {
        if (err) return res.status(500).json({ counties: [] });
        res.json({ counties: (rows || []).map((r) => r.county) });
      }
    );
  });

  // Distinct systems (for the talkgroup filter dropdown + import overview).
  app.get('/api/setup/talkgroup-systems', (req, res) => {
    const db = getDb();
    if (!db) return res.json({ systems: [] });
    db.all(
      `SELECT system, COUNT(*) AS count FROM talk_groups GROUP BY system ORDER BY system`,
      (err, rows) => {
        if (err) return res.json({ systems: [] });
        res.json({ systems: (rows || []).map((r) => ({ system: r.system || '', count: r.count })) });
      }
    );
  });

  // Clear imported talkgroups. Optionally limit to a single system so users can
  // re-import just one system without wiping the others.
  app.post('/api/setup/talkgroups/clear', (req, res) => {
    const db = getDb();
    if (!db) return res.status(500).json({ ok: false, error: 'No database' });
    const system = req.body && req.body.system != null ? String(req.body.system).trim().toLowerCase() : null;
    if (system !== null && system !== '__all__') {
      db.run('DELETE FROM talk_groups WHERE system = ?', [system], (err) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({ ok: true, system });
      });
    } else {
      db.run('DELETE FROM talk_groups', (err) => {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({ ok: true });
      });
    }
  });

  // --- Location helpers ---
  app.post('/api/setup/reverse-geocode', async (req, res) => {
    const { lat, lon } = req.body || {};
    if (lat == null || lon == null) return res.status(400).json({ ok: false, error: 'lat/lon required' });
    res.json(await geoHelpers.reverseGeocode(lat, lon));
  });

  app.get('/api/setup/geocode-search', async (req, res) => {
    res.json(await geoHelpers.forwardGeocode(req.query.q || ''));
  });

  app.post('/api/setup/cities-in-counties', async (req, res) => {
    const { state, counties } = req.body || {};
    res.json(await geoHelpers.citiesInCounties({ state, counties: counties || [] }));
  });

  // --- GPU / Python environment ---
  app.get('/api/setup/detect-gpu', (req, res) => res.json(pythonEnv.detectGpu()));
  app.get('/api/setup/detect-python', (req, res) => res.json({ pythons: pythonEnv.detectPythons() }));
  app.post('/api/setup/install-python', (req, res) => {
    const { device, basePython, torchIndex } = req.body || {};
    const result = pythonEnv.startInstall({ device, basePython, torchIndex });
    // If we kicked off a venv install, point the app at that interpreter.
    if (result.ok && result.venvPython) {
      try { envFile.writeValues({ PYTHON_COMMAND: result.venvPython }); } catch { /* ignore */ }
    }
    res.json(result);
  });
  app.get('/api/setup/install-python/status', (req, res) => res.json(pythonEnv.getInstallStatus()));

  // --- API keys ---
  app.get('/api/setup/apikeys', (req, res) => res.json({ keys: apiKeys.listKeys() }));
  app.post('/api/setup/apikeys/generate', (req, res) => {
    try {
      const name = (req.body && req.body.name) || 'Default';
      const key = apiKeys.generateKey(name);
      res.json({ ok: true, key, name });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- Maintenance / health dashboard ---
  app.get('/api/setup/app-version', (req, res) => res.json({ version: maintenance.appVersion() }));
  app.get('/api/setup/db-stats', async (req, res) => res.json(await maintenance.dbStats(getDb())));
  app.get('/api/setup/logs', (req, res) => res.json({ logs: maintenance.listLogs() }));
  app.get('/api/setup/log-tail', (req, res) =>
    res.json(maintenance.tailLog(req.query.name || 'combined.log', parseInt(req.query.lines, 10) || 200)));

  // Download a backup of the SQLite database.
  app.get('/api/setup/backup-db', (req, res) => {
    const dbPath = path.join(process.cwd(), 'botdata.db');
    if (!fs.existsSync(dbPath)) return res.status(404).json({ ok: false, error: 'Database not found' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.download(dbPath, `botdata-backup-${stamp}.db`);
  });

  // --- Software updates ---
  app.get('/api/setup/update/check', (req, res) => res.json(maintenance.updateCheck()));
  app.post('/api/setup/update/run', (req, res) => res.json(maintenance.updateRun()));
  app.get('/api/setup/update/status', (req, res) => res.json(maintenance.getUpdateStatus()));

  // --- Discord tools (proxied to the bot process) ---
  app.get('/api/setup/discord/channels', async (req, res) => res.json(await botProxy('/internal/discord/channels')));
  app.post('/api/setup/discord/delete', async (req, res) =>
    res.json(await botProxy('/internal/discord/delete', 'POST', {
      channelIds: (req.body && req.body.channelIds) || [],
      categoryIds: (req.body && req.body.categoryIds) || [],
      deleteCategoryChildren: !(req.body && req.body.deleteCategoryChildren === false),
      confirm: !!(req.body && req.body.confirm),
    })));
  app.post('/api/setup/discord/cleanup-empty', async (req, res) =>
    res.json(await botProxy('/internal/discord/cleanup-empty', 'POST', { confirm: !!(req.body && req.body.confirm) })));

  // --- Manual call plotting (unplotted transcripts) ---
  app.get('/api/setup/unplotted', (req, res) => {
    const db = getDb();
    if (!db) return res.json({ calls: [] });
    const search = (req.query.search || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const where = ["t.transcription IS NOT NULL", "t.transcription != ''", '(t.lat IS NULL OR t.lon IS NULL)'];
    const params = [];
    if (search) { where.push('(t.transcription LIKE ? OR t.talk_group_id LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    db.all(
      `SELECT t.id, t.talk_group_id, t.system, t.timestamp, t.transcription, t.address,
              COALESCE(
                (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = COALESCE(t.system,'') LIMIT 1),
                (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = '' LIMIT 1),
                (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id LIMIT 1)
              ) AS talk_group_name
       FROM transcriptions t
       WHERE ${where.join(' AND ')}
       ORDER BY t.timestamp DESC LIMIT ?`,
      [...params, limit],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ calls: rows || [] });
      }
    );
  });

  // Set/clear a call's location (reuses the same column the marker editor uses).
  app.post('/api/setup/plot', (req, res) => {
    const db = getDb();
    if (!db) return res.status(500).json({ ok: false, error: 'No database' });
    const { id, lat, lon, address } = req.body || {};
    const callId = parseInt(id, 10);
    if (isNaN(callId)) return res.status(400).json({ ok: false, error: 'Invalid id' });
    const latN = parseFloat(lat); const lonN = parseFloat(lon);
    if (isNaN(latN) || isNaN(lonN) || latN < -90 || latN > 90 || lonN < -180 || lonN > 180) {
      return res.status(400).json({ ok: false, error: 'Invalid lat/lon' });
    }
    db.run('UPDATE transcriptions SET lat = ?, lon = ?, address = ? WHERE id = ?',
      [latN, lonN, address || null, callId], function (err) {
        if (err) return res.status(500).json({ ok: false, error: err.message });
        res.json({ ok: true, changed: this.changes });
      });
  });

  app.post('/api/setup/save', (req, res) => {
    try {
      const updates = req.body || {};
      // Never let blank secret fields wipe existing stored secrets.
      const stored = envFile.readValues();
      for (const k of SECRET_KEYS) {
        if (updates[k] === '' || updates[k] == null) delete updates[k];
      }
      // Auto-generate a session secret if missing.
      if (!stored.SESSION_SECRET && !updates.SESSION_SECRET) {
        updates.SESSION_SECRET = envFile.generateSecret();
      }
      envFile.writeValues(updates);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/setup/finish', (req, res) => {
    try {
      if (req.body && Object.keys(req.body).length) envFile.writeValues(req.body);
      // Make sure an API key exists so we can show it to the user.
      let apiKey = null;
      try { apiKey = apiKeys.ensureDefault(); } catch { /* ignore */ }
      envFile.markSetupComplete();
      log.info('setup wizard completed');
      res.json({
        ok: true,
        apiKey,
        message: 'Setup complete. Restart the application to apply all settings.',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  log.info('setup wizard routes mounted at /api/setup and /setup');
}

module.exports = { mountSetup, safeStatus, runHealthChecks, isSetupComplete: envFile.isSetupComplete };
