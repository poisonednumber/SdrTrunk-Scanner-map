'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createLogger } = require('../logger');

const log = createLogger('python-env');

const IS_WIN = process.platform === 'win32';
const REPO_ROOT = process.cwd();
const VENV_DIR = path.join(REPO_ROOT, '.venv');

function venvPython() {
  return IS_WIN
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');
}

/**
 * If a project-local .venv exists and has the packages needed for local
 * transcription (faster_whisper), return its python path; otherwise null.
 * Lets the app auto-heal after a reset that wiped .env but kept .venv.
 */
function detectExistingVenv() {
  const py = venvPython();
  if (!fs.existsSync(py)) return null;
  try {
    const r = spawnSync(py, ['-c', 'import faster_whisper'], { encoding: 'utf8', timeout: 15000 });
    if (!r.error && r.status === 0) return py;
  } catch { /* ignore */ }
  return null;
}

/** Detect an NVIDIA GPU via nvidia-smi. Returns {available, name, driver, cuda, memory}. */
function detectGpu() {
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'], {
      encoding: 'utf8',
      timeout: 8000,
    });
    if (r.error || r.status !== 0) {
      return { available: false, reason: 'nvidia-smi not found (no NVIDIA GPU or driver).' };
    }
    const line = (r.stdout || '').trim().split(/\r?\n/)[0] || '';
    const [name, driver, memory] = line.split(',').map((s) => s.trim());

    // Detect max CUDA version supported by the driver from the smi header.
    let cuda = null;
    const head = spawnSync('nvidia-smi', [], { encoding: 'utf8', timeout: 8000 });
    const m = (head.stdout || '').match(/CUDA Version:\s*([\d.]+)/);
    if (m) cuda = m[1];

    // Map the driver's max CUDA to the closest PyTorch wheel tag. Newer GPUs
    // (e.g. Blackwell / RTX 50-series) need cu124+ wheels.
    let torchIndex = 'cu121';
    if (cuda) {
      const major = parseFloat(cuda);
      if (major >= 12.4) torchIndex = 'cu124';
      else if (major >= 12.1) torchIndex = 'cu121';
      else torchIndex = 'cu118';
    }

    return { available: true, name, driver, memory, cuda, recommendedTorch: torchIndex };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}

/** Find usable Python interpreters (3.8 - 3.12) on the system. */
function detectPythons() {
  const candidates = new Set();

  if (IS_WIN) {
    // py launcher lists installs with paths
    const py = spawnSync('py', ['-0p'], { encoding: 'utf8', timeout: 8000 });
    if (!py.error && py.stdout) {
      py.stdout.split(/\r?\n/).forEach((ln) => {
        const m = ln.match(/([A-Za-z]:\\[^\r\n]+python\.exe)/i);
        if (m) candidates.add(m[1].trim());
      });
    }
    const where = spawnSync('where', ['python'], { encoding: 'utf8', timeout: 8000 });
    if (!where.error && where.stdout) {
      where.stdout.split(/\r?\n/).forEach((ln) => {
        if (ln.trim().toLowerCase().endsWith('python.exe') && !ln.includes('WindowsApps')) {
          candidates.add(ln.trim());
        }
      });
    }
  } else {
    ['python3', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3.8', 'python'].forEach((c) => {
      const w = spawnSync('which', [c], { encoding: 'utf8', timeout: 5000 });
      if (!w.error && w.stdout.trim()) candidates.add(w.stdout.trim());
    });
  }

  const results = [];
  for (const exe of candidates) {
    const v = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const ver = `${v.stdout || ''}${v.stderr || ''}`.trim().replace(/^Python\s*/i, '');
    const m = ver.match(/^(\d+)\.(\d+)/);
    if (!m) continue;
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    const usable = major === 3 && minor >= 8 && minor <= 12;
    results.push({ path: exe, version: ver, usable });
  }
  // Prefer usable, newest first
  results.sort((a, b) => (b.usable - a.usable) || b.version.localeCompare(a.version, undefined, { numeric: true }));
  return results;
}

// ---- Install job (long-running, tracked in memory + log file) ----
const LOG_FILE = path.join(REPO_ROOT, 'logs', 'pip-install.log');
let job = { running: false, step: '', done: false, ok: false, error: null, startedAt: null, finishedAt: null };

function getInstallStatus() {
  let tail = '';
  try {
    const data = fs.readFileSync(LOG_FILE, 'utf8');
    tail = data.split(/\r?\n/).slice(-40).join('\n');
  } catch { /* no log yet */ }
  return { ...job, log: tail };
}

function appendLog(text) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, text);
  } catch { /* ignore */ }
}

function runStep(cmd, args, label) {
  return new Promise((resolve, reject) => {
    job.step = label;
    appendLog(`\n\n=== ${label} ===\n$ ${cmd} ${args.join(' ')}\n`);
    const child = spawn(cmd, args, { cwd: REPO_ROOT });
    child.stdout.on('data', (d) => appendLog(d.toString()));
    child.stderr.on('data', (d) => appendLog(d.toString()));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`))));
  });
}

/**
 * Create venv + install torch (matching the device) + faster-whisper deps.
 * Runs in the background; poll getInstallStatus().
 * @param {{device?: string, basePython?: string, torchIndex?: string}} opts
 */
function startInstall(opts = {}) {
  if (job.running) return { ok: false, error: 'Install already running' };

  const device = (opts.device || 'cpu').toLowerCase();
  const basePython = opts.basePython || process.env.PYTHON_COMMAND || (IS_WIN ? 'python' : 'python3');

  // torch wheel index based on device
  let torchArgs;
  if (device === 'cuda') {
    const idx = opts.torchIndex || 'cu121';
    torchArgs = ['install', 'torch', 'torchvision', 'torchaudio', '--index-url', `https://download.pytorch.org/whl/${idx}`];
  } else if (device === 'mps') {
    torchArgs = ['install', 'torch', 'torchvision', 'torchaudio']; // default wheels support MPS on macOS
  } else {
    torchArgs = ['install', 'torch', 'torchvision', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cpu'];
  }

  job = { running: true, step: 'starting', done: false, ok: false, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  try { fs.writeFileSync(LOG_FILE, `Scanner Map Python setup\nDevice: ${device}\nBase python: ${basePython}\n`); } catch { /* ignore */ }

  (async () => {
    try {
      if (!fs.existsSync(venvPython())) {
        await runStep(basePython, ['-m', 'venv', '.venv'], 'Create virtual environment');
      }
      const py = venvPython();
      await runStep(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'Upgrade pip');
      await runStep(py, ['-m', 'pip', ...torchArgs], `Install PyTorch (${device})`);
      await runStep(py, ['-m', 'pip', 'install', '-r', 'requirements.txt'], 'Install faster-whisper + dependencies');
      job.ok = true;
      job.step = 'complete';
      appendLog('\n\n=== DONE ===\nAll Python dependencies installed successfully.\n');
      log.info('Python dependency install completed.');
    } catch (e) {
      job.ok = false;
      job.error = e.message;
      appendLog(`\n\n=== ERROR ===\n${e.message}\n`);
      log.error(`Python dependency install failed: ${e.message}`);
    } finally {
      job.running = false;
      job.done = true;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return { ok: true, started: true, venvPython: venvPython() };
}

module.exports = { detectGpu, detectPythons, startInstall, getInstallStatus, venvPython, detectExistingVenv };
