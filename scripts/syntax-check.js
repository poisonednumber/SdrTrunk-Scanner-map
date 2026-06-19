#!/usr/bin/env node
'use strict';

/**
 * Syntax-check all project JS files with `node --check` (no execution).
 * Usage: node scripts/syntax-check.js
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  OK   ${path.relative(ROOT, file)}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${path.relative(ROOT, file)}`);
    console.error(String(err.stderr || err.message).trim());
  }
}

console.log(`\n${files.length - failed}/${files.length} files passed syntax check.`);
process.exit(failed ? 1 : 0);
