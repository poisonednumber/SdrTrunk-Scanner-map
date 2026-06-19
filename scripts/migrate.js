#!/usr/bin/env node
'use strict';

/**
 * Standalone DB migration runner: ensures performance indexes and the
 * storage_key/storage_mode columns exist. Safe to run anytime.
 *
 *   npm run migrate
 */

require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const { runMigrations } = require('../src/db/migrations');

const db = new sqlite3.Database('./botdata.db', (err) => {
  if (err) {
    console.error('Could not open botdata.db:', err.message);
    process.exit(1);
  }
});

runMigrations(db)
  .then(() => {
    console.log('Migrations applied successfully.');
    db.close(() => process.exit(0));
  })
  .catch((e) => {
    console.error('Migration failed:', e.message);
    db.close(() => process.exit(1));
  });
