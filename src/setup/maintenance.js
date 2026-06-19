'use strict';

/**
 * Maintenance / admin helpers used by the Settings page:
 *   - database statistics
 *   - log tailing
 *   - software update (git pull + npm install + migrate)
 *   - app version
 *
 * These are deliberately dependency-light and fail soft (returning structured
 * errors rather than throwing) so the Settings UI can render gracefully.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createLogger } = require('../logger');

const log = createLogger('maintenance');
const REPO_ROOT = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(REPO_ROOT, 'logs');

function appVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return 'unknown';
  }
}

/** Collect a quick snapshot of database size + row counts. */
function dbStats(db) {
  return new Promise((resolve) => {
    const out = { ok: true, version: appVersion() };
    try {
      const dbPath = path.join(REPO_ROOT, 'botdata.db');
      out.dbSizeMB = fs.existsSync(dbPath)
        ? Math.round((fs.statSync(dbPath).size / 1024 / 1024) * 10) / 10
        : 0;
    } catch { out.dbSizeMB = 0; }

    if (!db) { out.ok = false; out.error = 'No database'; return resolve(out); }

    const queries = {
      totalCalls: 'SELECT COUNT(*) AS n FROM transcriptions',
      transcribedCalls: "SELECT COUNT(*) AS n FROM transcriptions WHERE transcription IS NOT NULL AND transcription != ''",
      plottedCalls: 'SELECT COUNT(*) AS n FROM transcriptions WHERE lat IS NOT NULL AND lon IS NOT NULL',
      talkgroups: 'SELECT COUNT(*) AS n FROM talk_groups',
      systems: "SELECT COUNT(DISTINCT system) AS n FROM talk_groups",
      oldest: 'SELECT MIN(timestamp) AS t FROM transcriptions',
      newest: 'SELECT MAX(timestamp) AS t FROM transcriptions',
      last24h: `SELECT COUNT(*) AS n FROM transcriptions WHERE timestamp > ${Math.floor(Date.now() / 1000) - 86400}`,
    };
    const keys = Object.keys(queries);
    let pending = keys.length;
    keys.forEach((k) => {
      db.get(queries[k], (err, row) => {
        if (!err && row) out[k] = row.n != null ? row.n : row.t;
        if (--pending === 0) resolve(out);
      });
    });
  });
}

/** List available log files in ./logs. */
function listLogs() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const st = fs.statSync(path.join(LOG_DIR, f));
        return { name: f, sizeKB: Math.round(st.size / 1024), modified: st.mtime };
      });
  } catch {
    return [];
  }
}

/** Return the last N lines of a log file (safe, bounded read). */
function tailLog(name, lines = 200) {
  const safe = path.basename(name || 'combined.log');
  const file = path.join(LOG_DIR, safe);
  try {
    if (!fs.existsSync(file)) return { ok: false, error: 'Log not found' };
    const data = fs.readFileSync(file, 'utf8');
    const all = data.split(/\r?\n/).filter(Boolean);
    return { ok: true, name: safe, lines: all.slice(-Math.min(lines, 2000)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function isGitRepo() {
  return fs.existsSync(path.join(REPO_ROOT, '.git'));
}

/** Check whether a newer version is available on the git remote. */
function updateCheck() {
  if (!isGitRepo()) {
    return { ok: true, gitRepo: false, message: 'Not a git checkout — use the installer/download to update.' };
  }
  try {
    spawnSync('git', ['fetch', '--quiet'], { cwd: REPO_ROOT, timeout: 20000 });
    const local = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout?.trim();
    const remoteRef = spawnSync('git', ['rev-parse', '@{u}'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (remoteRef.status !== 0) {
      return { ok: true, gitRepo: true, behind: 0, message: 'No upstream branch configured.' };
    }
    const remote = remoteRef.stdout.trim();
    const countRes = spawnSync('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const behind = parseInt((countRes.stdout || '0').trim(), 10) || 0;
    const logRes = spawnSync('git', ['log', '--oneline', '-10', 'HEAD..@{u}'], { cwd: REPO_ROOT, encoding: 'utf8' });
    return {
      ok: true,
      gitRepo: true,
      behind,
      upToDate: behind === 0,
      local: local ? local.slice(0, 8) : null,
      remote: remote ? remote.slice(0, 8) : null,
      changelog: (logRes.stdout || '').split(/\r?\n/).filter(Boolean),
      version: appVersion(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

let updateJob = null; // { running, log:[], code }

function getUpdateStatus() {
  return updateJob || { running: false, log: [], code: null };
}

/** Run the update script in the background, streaming output into updateJob.log. */
function updateRun() {
  if (updateJob && updateJob.running) return { ok: false, error: 'Update already running' };
  if (!isGitRepo()) return { ok: false, error: 'Not a git checkout — cannot self-update.' };

  updateJob = { running: true, log: ['Starting update…'], code: null, startedAt: Date.now() };
  const isWin = process.platform === 'win32';
  const script = isWin
    ? path.join(REPO_ROOT, 'scripts', 'update.ps1')
    : path.join(REPO_ROOT, 'scripts', 'update.sh');

  let child;
  try {
    if (isWin) {
      child = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script], { cwd: REPO_ROOT });
    } else {
      child = spawn('bash', [script], { cwd: REPO_ROOT });
    }
  } catch (e) {
    updateJob.running = false; updateJob.code = -1; updateJob.log.push('Failed to spawn: ' + e.message);
    return { ok: false, error: e.message };
  }

  const append = (buf) => {
    const text = buf.toString();
    text.split(/\r?\n/).forEach((l) => { if (l) updateJob.log.push(l); });
    if (updateJob.log.length > 500) updateJob.log = updateJob.log.slice(-500);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code) => {
    updateJob.running = false;
    updateJob.code = code;
    updateJob.log.push(`Update finished with exit code ${code}.`);
    updateJob.log.push('Restart Scanner Map to run the new version.');
    log.info(`update finished code=${code}`);
  });
  child.on('error', (err) => {
    updateJob.running = false; updateJob.code = -1; updateJob.log.push('Error: ' + err.message);
  });

  return { ok: true, started: true };
}

module.exports = { appVersion, dbStats, listLogs, tailLog, updateCheck, updateRun, getUpdateStatus };
