'use strict';

/**
 * Standalone setup server.
 *
 * Runs when the app has not been configured yet. It serves ONLY the setup
 * wizard (and its API), so a brand-new install can be configured entirely
 * from the browser before the full bot/webserver stack starts.
 */

const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { applyBaseSecurity, apiLimiter } = require('../security/middleware');
const { mountSetup } = require('./routes');
const { createLogger } = require('../logger');

const log = createLogger('setup-server');

function ensureSchema(db) {
  db.serialize(() => {
    // Composite key (system, id): talkgroup ids collide across radio systems,
    // so the wizard can import the same id under multiple systems. Must match
    // the schema bot.js/migrations.js use.
    db.run(`CREATE TABLE IF NOT EXISTS talk_groups (
      id TEXT NOT NULL,
      system TEXT NOT NULL DEFAULT '',
      hex TEXT,
      alpha_tag TEXT,
      mode TEXT,
      description TEXT,
      tag TEXT,
      county TEXT,
      PRIMARY KEY (system, id)
    )`);
    // If an older DB created the legacy single-column schema, upgrade it in place.
    const { runMigrations } = require('../db/migrations');
    runMigrations(db).catch(() => {});
  });
}

function startSetupServer() {
  const port = parseInt(process.env.WEBSERVER_PORT, 10) || 8080;
  const app = express();

  applyBaseSecurity(app);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/setup', apiLimiter);

  const db = new sqlite3.Database('./botdata.db', (err) => {
    if (err) log.error(`db open failed: ${err.message}`);
    else ensureSchema(db);
  });

  mountSetup(app, { getDb: () => db });

  // One-click relaunch: when started via start.bat / start.sh (which set
  // SCANNER_LAUNCHER and loop on exit code 75), the wizard's "Start Scanner Map"
  // button hits this to exit-and-restart straight into the full app. If we
  // weren't started by the launcher, we can't safely self-restart, so we just
  // tell the client to do it manually.
  app.post('/api/setup/launch', (req, res) => {
    const launcher = !!process.env.SCANNER_LAUNCHER;
    res.json({ ok: true, launcher });
    if (launcher) {
      log.info('Setup complete — relaunching into the full app (exit 75)...');
      // Give the HTTP response time to flush before exiting.
      setTimeout(() => process.exit(75), 600);
    }
  });

  // Static assets (favicon, wizard files)
  app.use('/setup', express.static(path.join(process.cwd(), 'public', 'setup')));
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/api/health', (req, res) =>
    res.json({ status: 'setup', setupComplete: false, time: new Date().toISOString() })
  );

  // Everything funnels to the wizard until setup is finished.
  app.get('/setup', (req, res) =>
    res.sendFile(path.join(process.cwd(), 'public', 'setup', 'index.html'))
  );
  app.get('*', (req, res) => res.redirect('/setup'));

  const server = app.listen(port, () => {
    log.info(`========================================================`);
    log.info(`  Scanner Map is not configured yet.`);
    log.info(`  Open the setup wizard:  http://localhost:${port}/setup`);
    log.info(`========================================================`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${port} is already in use.`);
      log.error(`Another Scanner Map instance may be running, or set WEBSERVER_PORT to a free port:`);
      log.error(`  PowerShell:  $env:WEBSERVER_PORT=8090; node start.js`);
      log.error(`To find/stop the process using the port on Windows:`);
      log.error(`  Get-NetTCPConnection -LocalPort ${port} -State Listen | Stop-Process -Id { $_.OwningProcess } -Force`);
    } else {
      log.error(`Setup server failed to start: ${err.message}`);
    }
    process.exit(1);
  });
}

module.exports = { startSetupServer };
