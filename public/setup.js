const sections = document.querySelectorAll('.section');
const buttons = document.querySelectorAll('.step-button');

function showStep(id) {
  sections.forEach((section) => section.classList.toggle('active', section.id === id));
  buttons.forEach((button) => button.classList.toggle('active', button.dataset.step === id));
}

function renderMessage(targetId, message, type = 'ok') {
  const target = document.getElementById(targetId);
  target.innerHTML = `<div class="result-row"><span class="badge ${type}">${type}</span><div>${message}</div></div>`;
}

function labelFor(value) {
  return value.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function loadStatus() {
  const status = await jsonFetch('/api/setup/status');
  const el = document.getElementById('setup-status');
  el.textContent = status.setupComplete ? 'Setup complete' : `Missing: ${status.missing.join(', ') || 'review'}`;
  el.className = `status-pill ${status.setupComplete ? 'ok' : 'warn'}`;
}

async function runChecks() {
  const checks = await jsonFetch('/api/setup/checks');
  const rows = Object.entries(checks).map(([key, check]) => {
    const command = check.installCommand ? `<div>Install: <code>${check.installCommand}</code></div>` : '';
    const detail = check.version || check.error || check.url || '';
    return `<div class="check-row">
      <span class="badge ${check.ok ? 'ok' : (check.optional ? 'warn' : 'error')}">${check.ok ? 'ok' : (check.optional ? 'optional' : 'missing')}</span>
      <div><strong>${labelFor(key)}</strong><div>${detail}</div>${command}</div>
    </div>`;
  }).join('');
  document.getElementById('checks-list').innerHTML = rows;
}

buttons.forEach((button) => button.addEventListener('click', () => showStep(button.dataset.step)));

document.getElementById('run-checks').addEventListener('click', () => {
  runChecks().catch((error) => renderMessage('checks-list', error.message, 'error'));
});

document.getElementById('save-admin').addEventListener('click', async () => {
  const password = document.getElementById('admin-password').value;
  const confirm = document.getElementById('confirm-password').value;
  if (password !== confirm) return renderMessage('admin-result', 'Passwords do not match.', 'error');
  try {
    await jsonFetch('/api/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password })
    });
    renderMessage('admin-result', 'Admin account saved.');
    await loadStatus();
  } catch (error) {
    renderMessage('admin-result', error.message, 'error');
  }
});

document.getElementById('save-providers').addEventListener('click', async () => {
  try {
    await jsonFetch('/api/setup/settings', {
      method: 'POST',
      body: JSON.stringify({
        storageMode: document.getElementById('storage-mode').value,
        transcriptionMode: document.getElementById('transcription-mode').value,
        aiProvider: document.getElementById('ai-provider').value,
        timezone: document.getElementById('timezone').value
      })
    });

    const uploadKey = document.getElementById('upload-key').value;
    if (uploadKey) {
      await jsonFetch('/api/setup/secrets', {
        method: 'POST',
        body: JSON.stringify({ key: 'uploadApiKey', value: uploadKey })
      });
    }

    const geocodeKey = document.getElementById('geocode-key').value;
    if (geocodeKey) {
      await jsonFetch('/api/setup/secrets', {
        method: 'POST',
        body: JSON.stringify({ key: 'googleMapsApiKey', value: geocodeKey })
      });
    }

    renderMessage('provider-result', 'Provider settings saved. Restart may be required for some settings.');
    await loadStatus();
  } catch (error) {
    renderMessage('provider-result', error.message, 'error');
  }
});

document.getElementById('test-providers').addEventListener('click', async () => {
  try {
    const checks = await Promise.all(['geocoding', 'transcription', 'ai', 'storage', 'upload'].map((provider) =>
      jsonFetch('/api/setup/test-provider', { method: 'POST', body: JSON.stringify({ provider }) }).then((result) => [provider, result])
    ));
    document.getElementById('provider-result').innerHTML = checks.map(([provider, result]) =>
      `<div class="result-row"><span class="badge ${result.ok ? 'ok' : 'warn'}">${result.ok ? 'ok' : 'check'}</span><div><strong>${labelFor(provider)}</strong><pre>${JSON.stringify(result, null, 2)}</pre></div></div>`
    ).join('');
  } catch (error) {
    renderMessage('provider-result', error.message, 'error');
  }
});

document.getElementById('complete-setup').addEventListener('click', async () => {
  try {
    await jsonFetch('/api/setup/complete', { method: 'POST', body: '{}' });
    renderMessage('finish-result', 'Setup complete. You can open the map or settings.');
    await loadStatus();
  } catch (error) {
    renderMessage('finish-result', error.message, 'error');
  }
});

loadStatus().catch(() => {});
