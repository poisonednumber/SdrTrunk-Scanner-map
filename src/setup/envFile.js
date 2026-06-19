'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(process.cwd(), '.env');
const EXAMPLE_PATH = path.join(process.cwd(), '.env.example');

/** Parse a .env file into an ordered list of lines + a key index. */
function parseEnv(content) {
  const lines = content.split(/\r?\n/);
  const index = {};
  lines.forEach((line, i) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m) index[m[1]] = i;
  });
  return { lines, index };
}

function readRaw() {
  if (fs.existsSync(ENV_PATH)) return fs.readFileSync(ENV_PATH, 'utf8');
  if (fs.existsSync(EXAMPLE_PATH)) return fs.readFileSync(EXAMPLE_PATH, 'utf8');
  return '';
}

/** Read current env values (from process.env merged with the file). */
function readValues() {
  const { lines } = parseEnv(readRaw());
  const values = {};
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) values[m[1]] = parseValue(m[2]);
  }
  return values;
}

/**
 * Parse a raw .env value: unwrap quotes, or (for unquoted values) strip a
 * trailing inline `# comment` like dotenv does. This prevents .env.example
 * comments (e.g. "cpu   # cuda | cpu | mps") from leaking into saved values.
 */
function parseValue(raw) {
  if (raw == null) return raw;
  let t = raw.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const quote = t[0];
    // Take everything up to the matching closing quote; ignore any inline comment after it.
    const end = t.indexOf(quote, 1);
    if (end > 0) return t.slice(1, end).replace(/\\"/g, '"');
    return t.slice(1); // unterminated quote — best effort
  }
  // Unquoted: a `#` (optionally preceded by whitespace) begins a comment.
  const hash = t.search(/(^|\s)#/);
  if (hash >= 0) t = t.slice(0, hash);
  return t.trim();
}

function stripQuotes(v) {
  return parseValue(v);
}

function formatValue(v) {
  const s = String(v ?? '');
  if (s === '') return '';
  // Bare value when there's nothing dotenv would misinterpret.
  if (!/[\s#"'=\\]/.test(s)) return s;
  // Prefer single quotes: dotenv treats single-quoted values as literal, so
  // Windows paths like C:\Users\...\new scannermap\... are NOT mangled by
  // backslash-escape expansion (e.g. "\n" -> newline) that happens in double
  // quotes. Only fall back to (escaped) double quotes if a single quote exists.
  if (!s.includes("'")) return `'${s}'`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Merge updates into the existing .env, preserving comments/ordering.
 * New keys are appended under a "Setup Wizard" section.
 * @param {Record<string,string>} updates
 */
function writeValues(updates) {
  const raw = readRaw();
  const { lines, index } = parseEnv(raw);
  const appended = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const formatted = `${key}=${formatValue(value)}`;
    if (key in index) {
      lines[index[key]] = formatted;
    } else {
      appended.push(formatted);
    }
  }

  let output = lines.join('\n');
  if (appended.length) {
    output += `\n\n# ----- Added by Setup Wizard (${new Date().toISOString()}) -----\n`;
    output += appended.join('\n') + '\n';
  }

  // Atomic write
  const tmp = `${ENV_PATH}.tmp`;
  fs.writeFileSync(tmp, output, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
  return true;
}

/** Generate a strong random secret (hex). */
function generateSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Has initial setup been completed? */
function isSetupComplete() {
  const v = readValues();
  if (String(v.SETUP_COMPLETE || '').toLowerCase() === 'true') return true;
  return fs.existsSync(path.join(process.cwd(), '.setup-complete'));
}

function markSetupComplete() {
  writeValues({ SETUP_COMPLETE: 'true' });
  try {
    fs.writeFileSync(path.join(process.cwd(), '.setup-complete'), new Date().toISOString());
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  ENV_PATH,
  readValues,
  writeValues,
  generateSecret,
  isSetupComplete,
  markSetupComplete,
};
