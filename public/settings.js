const normalKeys = [
  'publicDomain', 'timezone', 'summaryLookbackHours', 'askAiLookbackHours',
  'mappedTalkGroups', 'enableMappedTalkGroups', 'storageMode', 'transcriptionMode',
  'transcriptionDevice', 'aiProvider', 'ollamaUrl', 'ollamaModel', 'openaiModel',
  'fasterWhisperServerUrl', 'whisperModel', 'openaiTranscriptionPrompt',
  'openaiTranscriptionModel', 'openaiTranscriptionTemperature', 'icadUrl', 'icadProfile'
];
const secretKeys = ['uploadApiKey', 'googleMapsApiKey', 'locationIqApiKey', 'openaiApiKey', 'icadApiKey'];

function showStep(id) {
  document.querySelectorAll('.section').forEach((section) => section.classList.toggle('active', section.id === id));
  document.querySelectorAll('.step-button').forEach((button) => button.classList.toggle('active', button.dataset.step === id));
}

document.querySelectorAll('.step-button').forEach((button) => button.addEventListener('click', () => showStep(button.dataset.step)));

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function loadSettings() {
  const data = await jsonFetch('/api/settings');
  for (const key of normalKeys) {
    const input = document.getElementById(key);
    if (input && data.settings[key]) input.value = data.settings[key].value;
  }
  for (const key of secretKeys) {
    const input = document.getElementById(key);
    if (input && data.secrets[key]?.configured) input.placeholder = 'Configured - enter a new value to replace';
  }
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const result = document.getElementById('save-result');
  try {
    const payload = {};
    for (const key of normalKeys) {
      const input = document.getElementById(key);
      if (input) payload[key] = input.value;
    }
    const saved = await jsonFetch('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });

    for (const key of secretKeys) {
      const input = document.getElementById(key);
      if (input && input.value) {
        await jsonFetch(`/api/settings/secrets/${key}`, { method: 'PUT', body: JSON.stringify({ value: input.value }) });
        input.value = '';
        input.placeholder = 'Configured - enter a new value to replace';
      }
    }

    result.textContent = saved.requiresRestart ? 'Saved. Restart required for some changes.' : 'Saved.';
  } catch (error) {
    result.textContent = error.message;
  }
});

document.getElementById('run-diagnostics').addEventListener('click', async () => {
  const output = document.getElementById('diagnostic-output');
  const checks = await jsonFetch('/api/settings/checks');
  output.innerHTML = `<pre>${JSON.stringify(checks, null, 2)}</pre>`;
});

document.getElementById('load-jobs').addEventListener('click', async () => {
  const output = document.getElementById('diagnostic-output');
  const [summary, recent] = await Promise.all([
    jsonFetch('/api/jobs/summary'),
    jsonFetch('/api/jobs/recent?limit=10')
  ]);
  output.innerHTML = `<pre>${JSON.stringify({ summary, recent }, null, 2)}</pre>`;
});

loadSettings().catch((error) => {
  document.getElementById('save-result').textContent = error.message;
});
