const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function checkCommand(command, args = ['--version']) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        command,
        version: (stdout || stderr || '').split(/\r?\n/)[0].trim(),
        error: error ? error.message : null
      });
    });
  });
}

function commandHint(name) {
  const isWindows = process.platform === 'win32';
  const hints = {
    node: isWindows ? 'winget install OpenJS.NodeJS.LTS' : 'sudo apt-get install -y nodejs npm',
    python: isWindows ? 'winget install Python.Python.3.11' : 'sudo apt-get install -y python3 python3-venv python3-pip',
    ffmpeg: isWindows ? 'winget install Gyan.FFmpeg' : 'sudo apt-get install -y ffmpeg',
    ollama: isWindows ? 'winget install Ollama.Ollama' : 'curl -fsSL https://ollama.com/install.sh | sh'
  };
  return hints[name] || '';
}

function checkWritableDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const testFile = path.join(dirPath, `.write-test-${Date.now()}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return { ok: true, path: dirPath };
  } catch (error) {
    return { ok: false, path: dirPath, error: error.message };
  }
}

async function runSetupChecks(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, '..', '..');
  const env = options.env || process.env;
  const runtime = options.runtime || { settings: {}, secrets: {} };
  const storageMode = (runtime.settings.storageMode || env.STORAGE_MODE || 'local').toLowerCase();
  const transcriptionMode = (runtime.settings.transcriptionMode || env.TRANSCRIPTION_MODE || 'local').toLowerCase();
  const aiProvider = (runtime.settings.aiProvider || env.AI_PROVIDER || 'ollama').toLowerCase();
  const hasS3Config = Boolean(
    runtime.settings.s3Endpoint || env.S3_ENDPOINT
  ) && Boolean(
    runtime.settings.s3BucketName || env.S3_BUCKET_NAME
  ) && Boolean(
    runtime.secrets.s3AccessKeyId || env.S3_ACCESS_KEY_ID
  ) && Boolean(
    runtime.secrets.s3SecretAccessKey || env.S3_SECRET_ACCESS_KEY
  );
  const transcriptionReady =
    transcriptionMode === 'local' ||
    (transcriptionMode === 'remote' && Boolean(runtime.settings.fasterWhisperServerUrl || env.FASTER_WHISPER_SERVER_URL)) ||
    (transcriptionMode === 'openai' && Boolean(runtime.secrets.openaiApiKey || env.OPENAI_API_KEY)) ||
    (transcriptionMode === 'icad' && Boolean(runtime.settings.icadUrl || env.ICAD_URL));
  const aiReady = aiProvider !== 'openai' || Boolean(runtime.secrets.openaiApiKey || env.OPENAI_API_KEY);
  const [node, python, ffmpeg, ollama] = await Promise.all([
    checkCommand(process.execPath, ['--version']),
    checkCommand(env.PYTHON_COMMAND || (process.platform === 'win32' ? 'py' : 'python3'), ['--version']),
    checkCommand('ffmpeg', ['-version']),
    checkCommand('ollama', ['--version'])
  ]);

  const checks = {
    node: { ...node, installCommand: commandHint('node') },
    python: { ...python, installCommand: commandHint('python') },
    ffmpeg: { ...ffmpeg, installCommand: commandHint('ffmpeg') },
    ollama: { ...ollama, optional: true, installCommand: commandHint('ollama') },
    cuda: { ok: false, optional: true, command: 'nvidia-smi', installCommand: 'Install NVIDIA drivers, CUDA Toolkit, cuDNN, and compatible PyTorch wheels.' },
    dataDir: checkWritableDir(path.join(rootDir, 'data')),
    audioDir: checkWritableDir(path.join(rootDir, 'audio')),
    geocodingProvider: {
      ok: Boolean(runtime.secrets.googleMapsApiKey || runtime.secrets.locationIqApiKey || env.GOOGLE_MAPS_API_KEY || env.LOCATIONIQ_API_KEY),
      configuredProviders: {
        google: Boolean(runtime.secrets.googleMapsApiKey || env.GOOGLE_MAPS_API_KEY),
        locationiq: Boolean(runtime.secrets.locationIqApiKey || env.LOCATIONIQ_API_KEY)
      }
    },
    transcriptionProvider: {
      ok: transcriptionReady,
      mode: transcriptionMode
    },
    aiProvider: {
      ok: aiReady,
      provider: aiProvider
    },
    storageProvider: {
      ok: storageMode === 'local' || hasS3Config,
      mode: storageMode
    },
    uploadEndpoint: {
      ok: Boolean(runtime.secrets.uploadApiKey || env.SCANNER_MAP_UPLOAD_API_KEY),
      url: `/api/call-upload`
    }
  };

  checks.cuda = await checkCommand('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']).then((result) => ({
    ...checks.cuda,
    ok: result.ok,
    version: result.version,
    error: result.error
  }));

  return checks;
}

module.exports = {
  checkCommand,
  checkWritableDir,
  runSetupChecks
};
