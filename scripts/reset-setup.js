#!/usr/bin/env node
'use strict';

/**
 * Reset Scanner Map back to "first-time setup" so the web Setup Wizard runs again.
 *
 * What it does:
 *   - Backs up your current .env to .env.bak (so you don't lose API keys).
 *   - Removes .env and the .setup-complete sentinel.
 *   - With --hard, also removes the generated API keys + database so the run
 *     is truly brand-new.
 *
 * Usage:
 *   node scripts/reset-setup.js          # soft reset (keeps DB + API keys backup)
 *   node scripts/reset-setup.js --hard   # also wipe API keys + botdata.db
 *
 * Then start the app:  node start.js   ->  open http://localhost:8080/setup
 */

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const hard = process.argv.includes('--hard');
const locked = []; // files we couldn't remove (held open by a running process)

// Best-effort remove with a couple of retries. On Windows a file held open by a
// running process throws EPERM/EBUSY; we record it and keep going instead of
// crashing the whole reset half-way through.
function rm(p, label) {
  const full = path.join(root, p);
  if (!fs.existsSync(full)) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`  removed ${label || p}`);
      return true;
    } catch (e) {
      if ((e.code === 'EPERM' || e.code === 'EBUSY') && attempt < 2) {
        // brief synchronous backoff, then retry
        try { require('child_process').execSync(process.platform === 'win32' ? 'timeout /t 1 >NUL 2>&1' : 'sleep 1'); } catch (_) { /* ignore */ }
        continue;
      }
      if (e.code === 'EPERM' || e.code === 'EBUSY') {
        console.log(`  ⚠ could not remove ${label || p} — file is in use`);
        locked.push(p);
        return false;
      }
      throw e;
    }
  }
  return false;
}

console.log('Resetting Scanner Map to first-time setup...');

// 1. Back up and remove .env
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  const bak = path.join(root, '.env.bak');
  fs.copyFileSync(envPath, bak);
  console.log('  backed up .env -> .env.bak');
  fs.rmSync(envPath, { force: true });
  console.log('  removed .env');
} else {
  console.log('  (.env not present)');
}

// 2. Remove the completion sentinel
rm('.setup-complete', '.setup-complete sentinel');

// 3. Hard reset extras
if (hard) {
  rm('data/apikeys.json', 'API key hashes');
  rm('data/apikeys.plain.json', 'API key plaintext');
  rm('botdata.db', 'database (talkgroups, calls, users)');
  // SQLite write-ahead-log sidecars (present when the DB was open in WAL mode)
  rm('botdata.db-wal', 'database WAL');
  rm('botdata.db-shm', 'database SHM');
  rm('logs/pip-install.log', 'python install log');
}

if (locked.length) {
  console.log('\n⚠  Some files are still in use and were NOT removed:');
  locked.forEach((p) => console.log(`     - ${p}`));
  console.log('\n   Scanner Map (or a leftover "node" process) is still running and holding these files.');
  console.log('   Stop it first, then re-run this command:');
  if (process.platform === 'win32') {
    console.log('     Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force');
    console.log('     node scripts/reset-setup.js' + (hard ? ' --hard' : ''));
  } else {
    console.log('     pkill -f "node .*(start|bot|webserver)\\.js"');
    console.log('     node scripts/reset-setup.js' + (hard ? ' --hard' : ''));
  }
  process.exitCode = 1;
} else {
  console.log('\nDone. Start the wizard with:\n');
  console.log('   node start.js');
  console.log('\nthen open  http://localhost:8080/setup');
  console.log(hard ? '(hard reset: a fresh API key + DB will be created)' : '(soft reset: your old config is saved in .env.bak)');
}
