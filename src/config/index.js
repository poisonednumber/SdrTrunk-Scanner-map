const DEFAULTS = {
  botPort: 3306,
  webserverPort: 3001,
  publicDomain: 'localhost',
  timezone: 'US/Eastern',
  apiKeyFile: 'data/apikeys.json',
  enableAuth: false,
  sessionDurationDays: 7,
  maxSessionsPerUser: 5,
  storageMode: 'local',
  aiProvider: 'ollama',
  openaiModel: 'gpt-4o-mini',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.1:8b',
  transcriptionMode: 'local',
  whisperModel: 'large-v3',
  transcriptionDevice: 'cpu',
  pythonCommand: 'python',
  autoUpdatePythonPackages: true,
  summaryLookbackHours: 1,
  askAiLookbackHours: 8,
  maxConcurrentTranscriptions: 3,
  enableMappedTalkGroups: true,
  enableTwoToneMode: false,
  twoToneQueueSize: 1
};

const SECRET_KEYS = new Set([
  'discordToken',
  'googleMapsApiKey',
  'locationIqApiKey',
  's3AccessKeyId',
  's3SecretAccessKey',
  'openaiApiKey',
  'icadApiKey',
  'webserverPassword'
]);

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback, { integer = false, min = undefined } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = integer ? parseInt(value, 10) : parseFloat(value);
  if (Number.isNaN(parsed)) return fallback;
  if (min !== undefined && parsed < min) return fallback;
  return parsed;
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function requireWhen(errors, condition, key, message) {
  if (condition) errors.push({ key, message });
}

function loadConfig(env = process.env) {
  const config = {
    discordToken: env.DISCORD_TOKEN || '',
    clientId: env.CLIENT_ID || '',
    botPort: parseNumber(env.BOT_PORT, DEFAULTS.botPort, { integer: true, min: 1 }),
    webserverPort: parseNumber(env.WEBSERVER_PORT, DEFAULTS.webserverPort, { integer: true, min: 1 }),
    publicDomain: env.PUBLIC_DOMAIN || DEFAULTS.publicDomain,
    timezone: env.TIMEZONE || DEFAULTS.timezone,
    apiKeyFile: env.API_KEY_FILE || DEFAULTS.apiKeyFile,
    enableAuth: parseBoolean(env.ENABLE_AUTH, DEFAULTS.enableAuth),
    webserverPassword: env.WEBSERVER_PASSWORD || '',
    sessionDurationDays: parseNumber(env.SESSION_DURATION_DAYS, DEFAULTS.sessionDurationDays, { integer: true, min: 1 }),
    maxSessionsPerUser: parseNumber(env.MAX_SESSIONS_PER_USER, DEFAULTS.maxSessionsPerUser, { integer: true, min: 1 }),
    googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || '',
    locationIqApiKey: env.LOCATIONIQ_API_KEY || '',
    storageMode: (env.STORAGE_MODE || DEFAULTS.storageMode).toLowerCase(),
    s3Endpoint: env.S3_ENDPOINT || '',
    s3BucketName: env.S3_BUCKET_NAME || '',
    s3AccessKeyId: env.S3_ACCESS_KEY_ID || '',
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    aiProvider: (env.AI_PROVIDER || DEFAULTS.aiProvider).toLowerCase(),
    openaiApiKey: env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_MODEL || DEFAULTS.openaiModel,
    ollamaUrl: env.OLLAMA_URL || DEFAULTS.ollamaUrl,
    ollamaModel: env.OLLAMA_MODEL || DEFAULTS.ollamaModel,
    transcriptionMode: (env.TRANSCRIPTION_MODE || DEFAULTS.transcriptionMode).toLowerCase(),
    fasterWhisperServerUrl: env.FASTER_WHISPER_SERVER_URL || '',
    whisperModel: env.WHISPER_MODEL || DEFAULTS.whisperModel,
    transcriptionDevice: (env.TRANSCRIPTION_DEVICE || DEFAULTS.transcriptionDevice).toLowerCase(),
    pythonCommand: env.PYTHON_COMMAND || DEFAULTS.pythonCommand,
    autoUpdatePythonPackages: parseBoolean(env.AUTO_UPDATE_PYTHON_PACKAGES, DEFAULTS.autoUpdatePythonPackages),
    icadUrl: env.ICAD_URL || '',
    icadProfile: env.ICAD_PROFILE || '',
    icadApiKey: env.ICAD_API_KEY || '',
    openaiTranscriptionPrompt: env.OPENAI_TRANSCRIPTION_PROMPT || '',
    openaiTranscriptionModel: env.OPENAI_TRANSCRIPTION_MODEL || '',
    openaiTranscriptionTemperature: env.OPENAI_TRANSCRIPTION_TEMPERATURE || '',
    mappedTalkGroups: parseList(env.MAPPED_TALK_GROUPS),
    enableMappedTalkGroups: parseBoolean(env.ENABLE_MAPPED_TALK_GROUPS, DEFAULTS.enableMappedTalkGroups),
    summaryLookbackHours: parseNumber(env.SUMMARY_LOOKBACK_HOURS, DEFAULTS.summaryLookbackHours, { min: 0 }),
    askAiLookbackHours: parseNumber(env.ASK_AI_LOOKBACK_HOURS, DEFAULTS.askAiLookbackHours, { min: 0 }),
    maxConcurrentTranscriptions: parseNumber(env.MAX_CONCURRENT_TRANSCRIPTIONS, DEFAULTS.maxConcurrentTranscriptions, { integer: true, min: 1 }),
    enableTwoToneMode: parseBoolean(env.ENABLE_TWO_TONE_MODE, DEFAULTS.enableTwoToneMode),
    twoToneTalkGroups: parseList(env.TWO_TONE_TALK_GROUPS),
    twoToneQueueSize: parseNumber(env.TWO_TONE_QUEUE_SIZE, DEFAULTS.twoToneQueueSize, { integer: true, min: 1 }),
    toneDetectionType: env.TONE_DETECTION_TYPE || '',
    twoToneMinToneLength: env.TWO_TONE_MIN_TONE_LENGTH || '',
    twoToneMaxToneLength: env.TWO_TONE_MAX_TONE_LENGTH || '',
    pulsedMinCycles: env.PULSED_MIN_CYCLES || '',
    pulsedMinOnMs: env.PULSED_MIN_ON_MS || '',
    pulsedMaxOnMs: env.PULSED_MAX_ON_MS || '',
    pulsedMinOffMs: env.PULSED_MIN_OFF_MS || '',
    pulsedMaxOffMs: env.PULSED_MAX_OFF_MS || '',
    pulsedBandwidthHz: env.PULSED_BANDWIDTH_HZ || '',
    longToneMinLength: env.LONG_TONE_MIN_LENGTH || '',
    longToneBandwidthHz: env.LONG_TONE_BANDWIDTH_HZ || '',
    toneDetectionThreshold: env.TONE_DETECTION_THRESHOLD || '',
    toneFrequencyBand: env.TONE_FREQUENCY_BAND || '',
    toneTimeResolutionMs: env.TONE_TIME_RESOLUTION_MS || ''
  };

  const errors = validateConfig(config);
  return { config, errors, isValid: errors.length === 0 };
}

function validateConfig(config) {
  const errors = [];
  const storageModes = new Set(['local', 's3']);
  const aiProviders = new Set(['ollama', 'openai']);
  const transcriptionModes = new Set(['local', 'remote', 'openai', 'icad']);
  const transcriptionDevices = new Set(['cpu', 'cuda']);

  requireWhen(errors, !storageModes.has(config.storageMode), 'STORAGE_MODE', 'Must be local or s3.');
  requireWhen(errors, !aiProviders.has(config.aiProvider), 'AI_PROVIDER', 'Must be ollama or openai.');
  requireWhen(errors, !transcriptionModes.has(config.transcriptionMode), 'TRANSCRIPTION_MODE', 'Must be local, remote, openai, or icad.');
  requireWhen(errors, !transcriptionDevices.has(config.transcriptionDevice), 'TRANSCRIPTION_DEVICE', 'Must be cpu or cuda.');

  requireWhen(errors, config.enableAuth && !config.webserverPassword, 'WEBSERVER_PASSWORD', 'Required when ENABLE_AUTH=true.');
  requireWhen(errors, config.storageMode === 's3' && !config.s3Endpoint, 'S3_ENDPOINT', 'Required when STORAGE_MODE=s3.');
  requireWhen(errors, config.storageMode === 's3' && !config.s3BucketName, 'S3_BUCKET_NAME', 'Required when STORAGE_MODE=s3.');
  requireWhen(errors, config.storageMode === 's3' && !config.s3AccessKeyId, 'S3_ACCESS_KEY_ID', 'Required when STORAGE_MODE=s3.');
  requireWhen(errors, config.storageMode === 's3' && !config.s3SecretAccessKey, 'S3_SECRET_ACCESS_KEY', 'Required when STORAGE_MODE=s3.');
  requireWhen(errors, config.aiProvider === 'openai' && !config.openaiApiKey, 'OPENAI_API_KEY', 'Required when AI_PROVIDER=openai.');
  requireWhen(errors, config.aiProvider === 'ollama' && !config.ollamaUrl, 'OLLAMA_URL', 'Required when AI_PROVIDER=ollama.');
  requireWhen(errors, config.aiProvider === 'ollama' && !config.ollamaModel, 'OLLAMA_MODEL', 'Required when AI_PROVIDER=ollama.');
  requireWhen(errors, config.transcriptionMode === 'remote' && !config.fasterWhisperServerUrl, 'FASTER_WHISPER_SERVER_URL', 'Required when TRANSCRIPTION_MODE=remote.');
  requireWhen(errors, config.transcriptionMode === 'openai' && !config.openaiApiKey, 'OPENAI_API_KEY', 'Required when TRANSCRIPTION_MODE=openai.');
  requireWhen(errors, config.transcriptionMode === 'icad' && !config.icadUrl, 'ICAD_URL', 'Required when TRANSCRIPTION_MODE=icad.');

  const toneKeys = [
    ['TWO_TONE_TALK_GROUPS', config.twoToneTalkGroups.length > 0],
    ['TONE_DETECTION_TYPE', config.toneDetectionType],
    ['TWO_TONE_MIN_TONE_LENGTH', config.twoToneMinToneLength],
    ['TWO_TONE_MAX_TONE_LENGTH', config.twoToneMaxToneLength],
    ['PULSED_MIN_CYCLES', config.pulsedMinCycles],
    ['PULSED_MIN_ON_MS', config.pulsedMinOnMs],
    ['PULSED_MAX_ON_MS', config.pulsedMaxOnMs],
    ['PULSED_MIN_OFF_MS', config.pulsedMinOffMs],
    ['PULSED_MAX_OFF_MS', config.pulsedMaxOffMs],
    ['PULSED_BANDWIDTH_HZ', config.pulsedBandwidthHz],
    ['LONG_TONE_MIN_LENGTH', config.longToneMinLength],
    ['LONG_TONE_BANDWIDTH_HZ', config.longToneBandwidthHz],
    ['TONE_DETECTION_THRESHOLD', config.toneDetectionThreshold],
    ['TONE_FREQUENCY_BAND', config.toneFrequencyBand],
    ['TONE_TIME_RESOLUTION_MS', config.toneTimeResolutionMs]
  ];

  if (config.enableTwoToneMode) {
    for (const [key, value] of toneKeys) {
      requireWhen(errors, !value, key, 'Required when ENABLE_TWO_TONE_MODE=true.');
    }
  }

  return errors;
}

function redactConfig(config) {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (SECRET_KEYS.has(key) && value) return [key, '[redacted]'];
      return [key, value];
    })
  );
}

module.exports = {
  DEFAULTS,
  loadConfig,
  parseBoolean,
  parseList,
  parseNumber,
  redactConfig,
  validateConfig
};
