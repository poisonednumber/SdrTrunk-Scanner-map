/* Scanner Map - Setup Wizard */
(function () {
  'use strict';

  // When loaded by /settings the page sets this flag: same steps, but presented
  // as freely-navigable tabs with a persistent Save button + extra admin steps.
  const SETTINGS_MODE = !!window.SCANNER_SETTINGS_MODE;

  const state = {}; // holds all config values keyed by env var name
  let current = 0;

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, html) => {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    });
    if (html != null) n.innerHTML = html;
    return n;
  };

  function toast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast show ${type}`;
    setTimeout(() => (t.className = 'toast'), 3200);
  }

  let authToken = null; // admin session token (only needed when auth is enabled)

  function authHeaders(base = {}) {
    return authToken ? { ...base, Authorization: `Bearer ${authToken}` } : base;
  }

  async function api(path, opts = {}) {
    const headers = authHeaders({ 'Content-Type': 'application/json', ...(opts.headers || {}) });
    const res = await fetch(path, { ...opts, headers });
    return res.json();
  }

  function set(key, value) { state[key] = value; }
  function get(key, def = '') { return state[key] != null ? state[key] : def; }

  // ---- Field builders ----------------------------------------------------
  function textField(key, label, hint, opts = {}) {
    const f = el('div', { class: 'field' });
    f.appendChild(el('label', {}, label));
    const input = el('input', {
      type: opts.password ? 'password' : (opts.number ? 'number' : 'text'),
      value: get(key, opts.default || ''),
      placeholder: opts.placeholder || (opts.password && state['__secretSet_' + key] ? '•••••••• (saved — leave blank to keep)' : ''),
    });
    input.addEventListener('input', () => set(key, input.value));
    f.appendChild(input);
    if (hint) f.appendChild(el('div', { class: 'hint', html: hint }, hint));
    return f;
  }

  function selectField(key, label, options, hint, onChange) {
    const f = el('div', { class: 'field' });
    if (label) f.appendChild(el('label', {}, label));
    const sel = el('select');
    options.forEach(([val, text]) => {
      const o = el('option', { value: val }, text);
      if (get(key) === val) o.selected = true;
      sel.appendChild(o);
    });
    if (!get(key) && options.length) set(key, options[0][0]);
    sel.addEventListener('change', () => { set(key, sel.value); if (onChange) onChange(sel.value); else renderStep(); });
    f.appendChild(sel);
    if (hint) f.appendChild(el('div', { class: 'hint' }, hint));
    return f;
  }

  function toggleField(key, label, hint) {
    const f = el('div', { class: 'field' });
    const wrap = el('div', { class: 'switch' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = String(get(key)).toLowerCase() === 'true';
    cb.addEventListener('change', () => { set(key, cb.checked ? 'true' : 'false'); renderStep(); });
    wrap.appendChild(cb);
    wrap.appendChild(el('label', { style: 'margin:0' }, label));
    f.appendChild(wrap);
    if (hint) f.appendChild(el('div', { class: 'hint' }, hint));
    return f;
  }

  function cardChoice(key, choices, onChange) {
    const wrap = el('div', { class: 'cards' });
    choices.forEach((c) => {
      const card = el('div', { class: 'card' + (get(key) === c.value ? ' selected' : '') });
      card.appendChild(el('div', { class: 'card-icon' }, c.icon || ''));
      card.appendChild(el('div', { class: 'card-title' }, c.title));
      card.appendChild(el('div', { class: 'card-desc' }, c.desc));
      card.addEventListener('click', () => { set(key, c.value); if (onChange) onChange(c.value); else renderStep(); });
      wrap.appendChild(card);
    });
    return wrap;
  }

  function infoBox(html, kind = 'info') {
    return el('div', { class: `infobox ${kind}` }, html);
  }

  // Reusable compact talkgroup checkbox picker that persists a comma-separated
  // list (system-scoped keys) to `stateKey`. Used by AI-summary scope and the
  // transcription whitelist/blacklist.
  function talkgroupMultiSelect(container, stateKey) {
    const selected = new Set((get(stateKey) || '').split(',').map((s) => s.trim()).filter(Boolean));
    const keyFor = (r) => (r.system ? `${r.system}:${r.id}` : String(r.id));
    const persist = () => set(stateKey, Array.from(selected).join(','));

    const controls = el('div', { class: 'tg-controls' });
    const searchInput = el('input', { type: 'text', placeholder: '🔍 Search talkgroups…' });
    const systemSel = el('select');
    systemSel.appendChild(el('option', { value: '' }, 'All systems'));
    controls.appendChild(searchInput); controls.appendChild(systemSel);
    container.appendChild(controls);

    const bulk = el('div', { class: 'tg-bulk' });
    const selCount = el('span', { class: 'sel-count' }, '');
    const dispatchBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, '✓ Check dispatch only');
    const selAllBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Check all shown');
    const clearBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Uncheck all');
    bulk.appendChild(dispatchBtn); bulk.appendChild(selAllBtn); bulk.appendChild(clearBtn); bulk.appendChild(selCount);
    container.appendChild(bulk);

    const tableWrap = el('div', { class: 'tg-table-wrap' });
    container.appendChild(tableWrap);

    const updateCount = () => { selCount.textContent = `${selected.size} selected`; persist(); };
    let currentRows = [];
    const renderTable = (rows) => {
      currentRows = rows;
      if (!rows.length) { tableWrap.innerHTML = '<div class="hint">No talkgroups found — import them on the Talkgroups tab first.</div>'; return; }
      const table = el('table');
      table.innerHTML = '<thead><tr><th></th><th>System</th><th>ID</th><th>Alpha Tag</th><th>Description</th></tr></thead>';
      const tbody = el('tbody');
      rows.forEach((r) => {
        const key = keyFor(r);
        const tr = el('tr');
        const cb = el('input', { type: 'checkbox' });
        cb.checked = selected.has(key);
        cb.addEventListener('change', () => { cb.checked ? selected.add(key) : selected.delete(key); updateCount(); });
        const td0 = el('td'); td0.appendChild(cb); tr.appendChild(td0);
        [r.system || '—', String(r.id), r.alpha_tag || '', r.description || ''].forEach((v) => tr.appendChild(el('td', {}, String(v).replace(/</g, '&lt;'))));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody); tableWrap.innerHTML = ''; tableWrap.appendChild(table);
    };
    const load = () => {
      const params = new URLSearchParams({ search: searchInput.value.trim(), system: systemSel.value, limit: '2000' });
      api('/api/setup/talkgroups?' + params).then((d) => renderTable(d.talkgroups || []));
    };
    const loadSystems = () => api('/api/setup/talkgroup-systems').then((d) => {
      systemSel.innerHTML = ''; systemSel.appendChild(el('option', { value: '' }, 'All systems'));
      (d.systems || []).forEach((s) => systemSel.appendChild(el('option', { value: s.system }, `${s.system || '(single system)'} — ${s.count}`)));
    });
    let t = null;
    searchInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    systemSel.addEventListener('change', load);
    dispatchBtn.addEventListener('click', async () => {
      // Respect the active search/system filter, then keep only dispatch channels.
      const p = new URLSearchParams({ search: searchInput.value.trim(), system: systemSel.value, limit: '10000' });
      const d = await api('/api/setup/talkgroups?' + p);
      const isDispatch = (r) => /dispatch/i.test(`${r.alpha_tag || ''} ${r.description || ''} ${r.tag || ''} ${r.id || ''}`);
      const found = (d.talkgroups || []).filter(isDispatch);
      found.forEach((r) => selected.add(keyFor(r)));
      updateCount(); load();
      toast(`Checked ${found.length} dispatch talkgroup(s)`, 'ok');
    });
    selAllBtn.addEventListener('click', () => { currentRows.forEach((r) => selected.add(keyFor(r))); updateCount(); load(); });
    clearBtn.addEventListener('click', () => { selected.clear(); updateCount(); load(); });
    updateCount(); loadSystems(); load();
  }

  function testButton(label, handler, fmt) {
    const row = el('div', { class: 'test-row' });
    const btn = el('button', { class: 'btn btn-sm', type: 'button' }, label);
    const result = el('span', { class: 'result' });
    btn.addEventListener('click', async () => {
      result.className = 'result pending';
      result.textContent = 'Testing…';
      btn.disabled = true;
      try {
        const r = await handler();
        if (r.ok) {
          result.className = 'result ok';
          result.textContent = '✓ ' + (fmt ? fmt(r) : (r.message || r.sample || r.botName || (r.bucket ? `bucket ${r.bucket}` : 'Success')));
        } else {
          result.className = 'result err';
          result.textContent = '✗ ' + (r.error || 'Failed');
        }
      } catch (e) {
        result.className = 'result err';
        result.textContent = '✗ ' + e.message;
      } finally {
        btn.disabled = false;
      }
    });
    row.appendChild(btn);
    row.appendChild(result);
    return row;
  }

  // ---- Steps --------------------------------------------------------------
  const steps = [
    // 0 — Welcome + system check
    {
      title: 'Welcome',
      render(c) {
        c.appendChild(el('h1', {}, 'Welcome to Scanner Map'));
        c.appendChild(el('p', { class: 'lead' },
          "Let's get your real-time scanner map running. This wizard checks your system, then walks you through location, geocoding, transcription, AI, Discord, storage, and talkgroups. Everything can be changed later from the in-app Settings page."));
        c.appendChild(el('h1', { style: 'font-size:18px' }, 'System check'));
        const list = el('ul', { class: 'health-list' }, '<li>Running checks…</li>');
        c.appendChild(list);
        api('/api/setup/health').then((h) => {
          list.innerHTML = '';
          const item = (ok, name, meta) => {
            const li = el('li');
            li.appendChild(el('span', { class: 'status' }, ok ? '✅' : '⚠️'));
            li.appendChild(el('span', {}, name));
            li.appendChild(el('span', { class: 'meta' }, meta || ''));
            return li;
          };
          list.appendChild(item(true, 'Node.js', h.node.version));
          list.appendChild(item(h.python.ok, 'Python', h.python.ok ? h.python.version : 'Not found — needed for local transcription'));
          list.appendChild(item(h.ffmpeg.ok, 'FFmpeg', h.ffmpeg.ok ? 'installed' : 'Not found — required for audio'));
          list.appendChild(item(h.diskWritable, 'Data directory writable', h.diskWritable ? 'ok' : 'check permissions'));
          list.appendChild(item(true, 'System', `${h.platform} · ${h.cpus} CPU · ${h.memoryGB} GB RAM`));
        });
      },
    },

    // 1 — Map & Location (with auto-locate)
    {
      title: 'Map & Location',
      render(c) {
        c.appendChild(el('h1', {}, 'Map & Location'));
        c.appendChild(el('p', { class: 'lead' }, 'Set your coverage area. This centers the map and helps the geocoder resolve addresses near you.'));

        const validCoord = (lat, lon) =>
          Number.isFinite(lat) && Number.isFinite(lon) &&
          lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
          !(Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001); // reject 0,0 "null island"

        const applyResult = (r) => {
          if (r.lat != null && r.lon != null) { set('MAP_CENTER_LAT', Number(r.lat).toFixed(6)); set('MAP_CENTER_LON', Number(r.lon).toFixed(6)); }
          if (r.city) set('GEOCODING_CITY', r.city);
          if (r.state) set('GEOCODING_STATE', r.state);
          if (r.county) set('GEOCODING_TARGET_COUNTIES', r.county);
          if (r.country) set('GEOCODING_COUNTRY', r.country);
        };

        // --- Option A: browser geolocation (best-effort) ---
        const locateRow = el('div', { class: 'test-row' });
        const locateBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '📍 Use my current location');
        const locateResult = el('span', { class: 'result' });
        locateBtn.addEventListener('click', () => {
          if (!navigator.geolocation) { locateResult.className = 'result err'; locateResult.textContent = 'Not supported — use the search box below'; return; }
          locateResult.className = 'result pending';
          locateResult.textContent = 'Detecting…';
          navigator.geolocation.getCurrentPosition(async (pos) => {
            const { latitude, longitude } = pos.coords;
            if (!validCoord(latitude, longitude)) {
              locateResult.className = 'result err';
              locateResult.textContent = `✗ Got invalid coordinates (${latitude.toFixed(3)}, ${longitude.toFixed(3)}). Use the search box below instead.`;
              return;
            }
            try {
              const r = await api('/api/setup/reverse-geocode', { method: 'POST', body: JSON.stringify({ lat: latitude, lon: longitude }) });
              applyResult(r.ok ? { ...r, lat: latitude, lon: longitude } : { lat: latitude, lon: longitude });
              locateResult.className = 'result ok';
              locateResult.textContent = r.ok
                ? `✓ ${r.city || ''}${r.county ? ', ' + r.county : ''} ${r.state || ''}`.trim()
                : `✓ Coordinates saved (${latitude.toFixed(3)}, ${longitude.toFixed(3)})`;
              renderStep();
            } catch (e) {
              locateResult.className = 'result err';
              locateResult.textContent = '✗ ' + e.message;
            }
          }, (err) => {
            locateResult.className = 'result err';
            locateResult.textContent = `✗ ${err.message}. No problem — search for your location below.`;
          }, { enableHighAccuracy: true, timeout: 10000 });
        });
        locateRow.appendChild(locateBtn);
        locateRow.appendChild(locateResult);
        c.appendChild(locateRow);

        // --- Option B: search by city/address (works without GPS or a key) ---
        c.appendChild(el('div', { class: 'hint', style: 'margin:10px 0 4px' }, 'Or search for your city / address (recommended if location is off or wrong):'));
        const searchRow = el('div', { class: 'test-row' });
        const searchInput = el('input', { type: 'text', placeholder: 'e.g. Silver Spring, MD', style: 'flex:1' });
        const searchBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, '🔎 Search');
        searchRow.appendChild(searchInput); searchRow.appendChild(searchBtn);
        c.appendChild(searchRow);
        const searchResults = el('div', { class: 'geo-results' });
        c.appendChild(searchResults);

        const doSearch = async () => {
          const q = searchInput.value.trim();
          if (q.length < 3) { searchResults.innerHTML = '<div class="hint">Type at least 3 characters.</div>'; return; }
          searchResults.innerHTML = '<div class="hint">Searching…</div>';
          try {
            const r = await api('/api/setup/geocode-search?q=' + encodeURIComponent(q));
            if (!r.ok || !r.results.length) { searchResults.innerHTML = `<div class="hint">No matches${r.error ? ' (' + r.error + ')' : ''}. Try adding the state/country.</div>`; return; }
            searchResults.innerHTML = '';
            r.results.forEach((res) => {
              const item = el('button', { class: 'geo-result', type: 'button' }, res.label);
              item.addEventListener('click', () => { applyResult(res); renderStep(); toast('Location set', 'ok'); });
              searchResults.appendChild(item);
            });
          } catch (e) { searchResults.innerHTML = `<div class="hint">✗ ${e.message}</div>`; }
        };
        searchBtn.addEventListener('click', doSearch);
        searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

        if (validCoord(parseFloat(get('MAP_CENTER_LAT')), parseFloat(get('MAP_CENTER_LON')))) {
          c.appendChild(el('div', { class: 'hint', style: 'margin-top:8px' }, `✓ Map will center on ${get('MAP_CENTER_LAT')}, ${get('MAP_CENTER_LON')}`));
        }

        c.appendChild(el('hr', { class: 'sep' }));
        c.appendChild(textField('GEOCODING_CITY', 'Primary city', 'e.g. Silver Spring'));
        const row = el('div', { class: 'row' });
        row.appendChild(textField('GEOCODING_STATE', 'State / Province', 'e.g. MD'));
        row.appendChild(textField('GEOCODING_COUNTRY', 'Country code', 'e.g. US'));
        c.appendChild(row);
        c.appendChild(textField('GEOCODING_TARGET_COUNTIES', 'Target counties', 'Comma-separated. e.g. Montgomery County, Howard County'));
        const coordRow = el('div', { class: 'row' });
        coordRow.appendChild(textField('MAP_CENTER_LAT', 'Map center latitude', 'Auto-filled above, or enter manually.'));
        coordRow.appendChild(textField('MAP_CENTER_LON', 'Map center longitude', 'Leave blank to use the app default.'));
        c.appendChild(coordRow);
        c.appendChild(textField('PUBLIC_DOMAIN', 'Public URL', 'How users reach this server (include http/https). e.g. http://192.168.1.50'));
        c.appendChild(selectField('TIMEZONE', 'Timezone', [
          ['America/New_York', 'America/New_York (Eastern)'],
          ['America/Chicago', 'America/Chicago (Central)'],
          ['America/Denver', 'America/Denver (Mountain)'],
          ['America/Los_Angeles', 'America/Los_Angeles (Pacific)'],
          ['America/Phoenix', 'America/Phoenix (Arizona)'],
          ['UTC', 'UTC'],
        ], null, () => {}));
      },
    },

    // 2 — Geocoding
    {
      title: 'Geocoding',
      render(c) {
        c.appendChild(el('h1', {}, 'Geocoding Provider'));
        c.appendChild(el('p', { class: 'lead' }, 'Turns extracted addresses into map coordinates. Keys stay on the server and are never exposed to browsers.'));
        c.appendChild(cardChoice('__geo_provider', [
          { value: 'google', icon: '🗺️', title: 'Google Maps', desc: 'Most accurate. Requires a billing-enabled Google Cloud key.' },
          { value: 'locationiq', icon: '📍', title: 'LocationIQ', desc: 'Generous free tier. Great for hobby setups.' },
        ]));
        if (!get('__geo_provider')) set('__geo_provider', get('GOOGLE_MAPS_API_KEY') || state['__secretSet_GOOGLE_MAPS_API_KEY'] ? 'google' : 'locationiq');
        const provider = get('__geo_provider');
        if (provider === 'google') {
          c.appendChild(textField('GOOGLE_MAPS_API_KEY', 'Google Maps API key', 'Enable the Geocoding API + Places API in Google Cloud.', { password: true }));
          c.appendChild(testButton('Test Google key', () => api('/api/setup/test/geocoding', { method: 'POST', body: JSON.stringify({ provider: 'google', key: get('GOOGLE_MAPS_API_KEY') }) }), (r) => r.sample));
        } else {
          c.appendChild(textField('LOCATIONIQ_API_KEY', 'LocationIQ API key', 'Get one free at locationiq.com.', { password: true }));
          c.appendChild(testButton('Test LocationIQ key', () => api('/api/setup/test/geocoding', { method: 'POST', body: JSON.stringify({ provider: 'locationiq', key: get('LOCATIONIQ_API_KEY') }) }), (r) => r.sample));
        }
      },
    },

    // 3 — Transcription (detailed instructions + GPU auto-setup)
    {
      title: 'Transcription',
      render(c) {
        c.appendChild(el('h1', {}, 'Audio Transcription'));
        c.appendChild(el('p', { class: 'lead' }, 'How should radio audio be turned into text? Pick the option that matches your hardware and budget.'));
        c.appendChild(cardChoice('TRANSCRIPTION_MODE', [
          { value: 'local', icon: '💻', title: 'Local (faster-whisper)', desc: 'Runs on this machine. Free. NVIDIA GPU strongly recommended.' },
          { value: 'openai', icon: '☁️', title: 'OpenAI Whisper', desc: 'Cloud API. No local GPU. Pay per minute.' },
          { value: 'remote', icon: '🌐', title: 'Remote server', desc: 'A faster-whisper / speaches server you host elsewhere.' },
          { value: 'icad', icon: '📻', title: 'ICAD', desc: 'Radio-optimized ICAD transcribe server.' },
        ]));
        const mode = get('TRANSCRIPTION_MODE', 'local');

        if (mode === 'local') {
          c.appendChild(infoBox(
            '<b>Local transcription</b> runs the faster-whisper model on this computer. It needs <b>Python 3.8–3.12</b> and <b>PyTorch</b>. ' +
            'A modern <b>NVIDIA GPU</b> is many times faster than CPU. Use the buttons below and we will detect your GPU and install the correct PyTorch build for you.'));
          renderLocalGpuSetup(c);
          c.appendChild(selectField('WHISPER_MODEL', 'Whisper model', [
            ['large-v3-turbo', 'large-v3-turbo (recommended balance)'],
            ['large-v3', 'large-v3 (most accurate, slower)'],
            ['medium', 'medium'], ['small', 'small'], ['base', 'base (fastest, least accurate)'],
          ], 'Bigger = more accurate but slower and more VRAM.', () => {}));
        } else if (mode === 'openai') {
          c.appendChild(infoBox(
            '<b>OpenAI Whisper</b> sends each clip to OpenAI for transcription. No GPU needed. ' +
            'You need an API key from <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a> with billing enabled. ' +
            'Roughly $0.006/min of audio.'));
          c.appendChild(textField('OPENAI_API_KEY', 'OpenAI API key', 'Reused for AI features too if you pick OpenAI there.', { password: true }));
          c.appendChild(textField('OPENAI_TRANSCRIPTION_MODEL', 'Model', 'whisper-1 is standard.', { default: 'whisper-1' }));
          c.appendChild(testButton('Test OpenAI key', () => api('/api/setup/test/openai', { method: 'POST', body: JSON.stringify({ key: get('OPENAI_API_KEY') }) })));
        } else if (mode === 'remote') {
          c.appendChild(infoBox(
            '<b>Remote faster-whisper</b> points Scanner Map at a separate transcription server you run ' +
            '(e.g. <a href="https://github.com/speaches-ai/speaches" target="_blank" rel="noopener">speaches</a> or a faster-whisper server) — possibly a GPU box elsewhere on your network. ' +
            'Enter its base URL below. It must expose an OpenAI-compatible <code>/v1/audio/transcriptions</code> endpoint.'));
          c.appendChild(textField('FASTER_WHISPER_SERVER_URL', 'Server URL', 'e.g. http://192.168.1.20:9912', { default: 'http://127.0.0.1:9912' }));
          c.appendChild(textField('WHISPER_MODEL', 'Model name the server should use', '', { default: 'large-v3-turbo' }));
        } else if (mode === 'icad') {
          c.appendChild(infoBox(
            '<b>ICAD Transcribe</b> is a radio-optimized server from the icad project. ' +
            'Install it from <a href="https://github.com/TheGreatCodeholio/icad_transcribe" target="_blank" rel="noopener">github.com/TheGreatCodeholio/icad_transcribe</a>, ' +
            'then enter its URL, API key, and profile name below.'));
          c.appendChild(textField('ICAD_URL', 'ICAD URL', 'e.g. http://127.0.0.1:9912', { default: 'http://127.0.0.1:9912' }));
          c.appendChild(textField('ICAD_API_KEY', 'ICAD API key', 'From your ICAD server config.', { password: true }));
          c.appendChild(textField('ICAD_PROFILE', 'ICAD profile', 'e.g. large', { default: 'large' }));
        }

        // --- Transcription whitelist / blacklist -------------------------
        c.appendChild(el('h1', { style: 'font-size:18px;margin-top:22px' }, 'What to transcribe'));
        c.appendChild(infoBox(
          '<b>TrunkRecorder uploads every call</b> — it can\'t pre-filter like SDRTrunk, which means you may be transcribing a lot of ' +
          'noise. Use a <b>whitelist</b> (only transcribe checked talkgroups) or <b>blacklist</b> (transcribe everything except checked) ' +
          'to cut CPU/API cost. Calls are still received and stored either way — they just skip transcription.'));
        c.appendChild(selectField('TRANSCRIBE_MODE', 'Filter mode', [
          ['all', 'Transcribe everything (default)'],
          ['whitelist', 'Whitelist — only transcribe checked talkgroups'],
          ['blacklist', 'Blacklist — transcribe all except checked talkgroups'],
        ], 'Choose how to filter which talkgroups get transcribed.'));
        if (get('TRANSCRIBE_MODE', 'all') !== 'all') {
          talkgroupMultiSelect(c, 'TRANSCRIBE_TALK_GROUPS');
        }
      },
    },

    // 4 — AI Features (Ollama remote note + model dropdown)
    {
      title: 'AI Features',
      render(c) {
        c.appendChild(el('h1', {}, 'AI Provider'));
        c.appendChild(el('p', { class: 'lead' }, 'Powers address extraction from transcripts, dispatch summaries, and Ask-AI.'));
        c.appendChild(cardChoice('AI_PROVIDER', [
          { value: 'openai', icon: '🤖', title: 'OpenAI', desc: 'gpt-4o-mini is cheap and accurate. Cloud-based.' },
          { value: 'ollama', icon: '🦙', title: 'Ollama (local/self-host)', desc: 'Free and private. Runs on your hardware or another machine.' },
        ]));
        const p = get('AI_PROVIDER', 'openai');
        if (p === 'openai') {
          c.appendChild(textField('OPENAI_API_KEY', 'OpenAI API key', 'Leave blank to reuse the transcription key.', { password: true }));
          c.appendChild(textField('OPENAI_MODEL', 'Model', 'gpt-4o-mini recommended.', { default: 'gpt-4o-mini' }));
          c.appendChild(testButton('Test OpenAI key', () => api('/api/setup/test/openai', { method: 'POST', body: JSON.stringify({ key: get('OPENAI_API_KEY') }) })));
        } else {
          c.appendChild(infoBox(
            '<b>Ollama does not need to run on this machine.</b> If you have it on another computer (e.g. a GPU box), ' +
            'set the URL to that host, like <code>http://192.168.1.20:11434</code>. On that machine, Ollama must listen on the network ' +
            '(set <code>OLLAMA_HOST=0.0.0.0</code>) and have the model pulled (<code>ollama pull llama3.1:8b</code>).'));
          c.appendChild(textField('OLLAMA_URL', 'Ollama URL', 'Local or remote.', { default: 'http://localhost:11434' }));
          renderOllamaModelPicker(c);
        }

        // --- AI summary scope -------------------------------------------
        c.appendChild(el('h1', { style: 'font-size:18px;margin-top:22px' }, 'AI summary scope'));
        c.appendChild(infoBox(
          'The <b>#dispatch-summary</b> channel posts a rolling AI summary of recent activity. By default it covers every transcribed ' +
          'talkgroup. Turn this on to focus the summary on just the talkgroups you care about (e.g. dispatch only).'));
        c.appendChild(toggleField('ENABLE_SUMMARY_TALK_GROUPS', 'Limit the AI summary to specific talkgroups', 'Off = summarize all transcribed talkgroups.'));
        if (String(get('ENABLE_SUMMARY_TALK_GROUPS')).toLowerCase() === 'true') {
          talkgroupMultiSelect(c, 'SUMMARY_TALK_GROUPS');
        }
      },
    },

    // 5 — Discord (dev portal instructions)
    {
      title: 'Discord',
      render(c) {
        c.appendChild(el('h1', {}, 'Discord Integration'));
        c.appendChild(el('p', { class: 'lead' }, 'Optional. Posts transcriptions, alerts and summaries to Discord. You can run a pure web map without it.'));
        c.appendChild(toggleField('MAP_ONLY_MODE', 'Run without Discord (web map only)', 'Enable this to skip the Discord bot entirely.'));
        if (String(get('MAP_ONLY_MODE')).toLowerCase() === 'true') return;

        c.appendChild(infoBox(
          '<b>Create your bot at <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers/applications</a>:</b>' +
          '<ol class="steps">' +
          '<li>Click <b>New Application</b>, name it, then open the <b>Bot</b> tab.</li>' +
          '<li>Click <b>Reset Token</b> → copy it into <b>Bot token</b> below.</li>' +
          '<li>Under <b>Privileged Gateway Intents</b>, enable all three: <b>Presence</b>, <b>Server Members</b>, and <b>Message Content</b>.</li>' +
          '<li>On the <b>Installation</b> / <b>OAuth2 → URL Generator</b> page, select scopes <b>bot</b> and <b>applications.commands</b>.</li>' +
          '<li>Bot permissions: <b>Send Messages</b>, <b>Embed Links</b>, <b>Attach Files</b>, <b>Read Message History</b>, <b>Connect</b>, <b>Speak</b>, <b>Manage Channels</b> (for auto-creating the alerts/summary channels).</li>' +
          '<li>Open the generated URL to invite the bot to your server.</li>' +
          '<li>Copy your app\'s <b>Application ID</b> (General Information) into <b>Client ID</b> below.</li>' +
          '</ol>'));
        c.appendChild(textField('DISCORD_TOKEN', 'Bot token', '', { password: true }));
        c.appendChild(textField('CLIENT_ID', 'Application (Client) ID', ''));
        c.appendChild(testButton('Test Discord token', () => api('/api/setup/test/discord', { method: 'POST', body: JSON.stringify({ token: get('DISCORD_TOKEN') }) }), (r) => `Connected as ${r.botName}`));
      },
    },

    // 6 — Audio Storage
    {
      title: 'Audio Storage',
      render(c) {
        c.appendChild(el('h1', {}, 'Audio Storage'));
        c.appendChild(el('p', { class: 'lead' }, 'Where to keep recorded call audio.'));
        c.appendChild(cardChoice('STORAGE_MODE', [
          { value: 'local', icon: '🗄️', title: 'Local disk', desc: 'Simple. Stored in ./audio.' },
          { value: 'r2', icon: '🟧', title: 'Cloudflare R2', desc: 'S3-compatible, zero egress fees.' },
          { value: 's3', icon: '🪣', title: 'Amazon S3', desc: 'Classic cloud object storage.' },
          { value: 'b2', icon: '🟥', title: 'Backblaze B2', desc: 'Cheap S3-compatible storage.' },
          { value: 'minio', icon: '📦', title: 'MinIO', desc: 'Self-hosted S3-compatible.' },
        ]));
        const mode = get('STORAGE_MODE', 'local');
        if (mode === 'local') {
          c.appendChild(textField('LOCAL_AUDIO_DIR', 'Audio directory', '', { default: 'audio' }));
        } else {
          const help = {
            r2: 'Endpoint: https://&lt;account_id&gt;.r2.cloudflarestorage.com · Region: auto',
            s3: 'Leave endpoint blank for AWS. Set a region like us-east-1.',
            b2: 'Endpoint: https://s3.&lt;region&gt;.backblazeb2.com',
            minio: 'Endpoint: http://your-host:9000 · path-style auto-enabled',
          }[mode];
          c.appendChild(infoBox(help));
          c.appendChild(textField('S3_ENDPOINT', 'Endpoint URL', '', { placeholder: 'https://...' }));
          const row = el('div', { class: 'row' });
          row.appendChild(textField('S3_REGION', 'Region', '', { default: mode === 's3' ? 'us-east-1' : 'auto' }));
          row.appendChild(textField('S3_BUCKET_NAME', 'Bucket name', ''));
          c.appendChild(row);
          c.appendChild(textField('S3_ACCESS_KEY_ID', 'Access key ID', '', { password: true }));
          c.appendChild(textField('S3_SECRET_ACCESS_KEY', 'Secret access key', '', { password: true }));
          c.appendChild(textField('S3_PUBLIC_BASE_URL', 'Public base URL (optional)', 'If your bucket is public/CDN-backed, audio is served from here.'));
          c.appendChild(testButton('Test storage connection', () => api('/api/setup/test/storage', {
            method: 'POST',
            body: JSON.stringify({
              STORAGE_MODE: mode, S3_ENDPOINT: get('S3_ENDPOINT'), S3_REGION: get('S3_REGION'),
              S3_BUCKET_NAME: get('S3_BUCKET_NAME'), S3_ACCESS_KEY_ID: get('S3_ACCESS_KEY_ID'),
              S3_SECRET_ACCESS_KEY: get('S3_SECRET_ACCESS_KEY'), S3_FORCE_PATH_STYLE: mode === 'minio' ? 'true' : 'false',
            }),
          }), (r) => `Connected (${r.bucket || r.location || 'ok'})`));
        }
        c.appendChild(textField('AUDIO_RETENTION_DAYS', 'Retention (days)', '0 = keep forever. Older audio is auto-deleted from disk and cloud.', { number: true, default: '30' }));
      },
    },

    // 7 — Network & Auth (port 80 default)
    {
      title: 'Network & Auth',
      render(c) {
        c.appendChild(el('h1', {}, 'Network & Access'));
        c.appendChild(el('p', { class: 'lead' }, 'Ports and optional password protection.'));
        const row = el('div', { class: 'row' });
        row.appendChild(textField('WEBSERVER_PORT', 'Web interface port', 'Default 80 (standard HTTP). Use 8080 if 80 is taken.', { number: true, default: '80' }));
        row.appendChild(textField('BOT_PORT', 'Scanner upload port', 'SDRTrunk / TrunkRecorder / rdio-scanner send calls here.', { number: true, default: '3306' }));
        c.appendChild(row);
        if (!get('WEBSERVER_PORT')) set('WEBSERVER_PORT', '80');
        c.appendChild(infoBox('On Linux, binding port <b>80</b> may require running with elevated privileges. On Windows, make sure no other web server (IIS, Skype) is using it.'));
        c.appendChild(toggleField('ENABLE_AUTH', 'Require login to view the map', 'Recommended if exposed to the internet.'));
        if (String(get('ENABLE_AUTH')).toLowerCase() === 'true') {
          c.appendChild(textField('WEBSERVER_PASSWORD', 'Admin password', 'Username is "admin".', { password: true }));
        }
      },
    },

    // 8 — Talkgroups (search/sort/multi-csv/clear)
    {
      title: 'Talkgroups',
      render(c) {
        c.appendChild(el('h1', {}, 'Talkgroups'));
        c.appendChild(el('p', { class: 'lead' }, 'Import your RadioReference talkgroup CSV(s), then tick which talkgroups should be plotted on the map.'));
        c.appendChild(infoBox(
          '<b>Checking a talkgroup = it gets mapped.</b> Only checked talkgroups have their calls geocoded and plotted. ' +
          'Leave a talkgroup unchecked to still receive/transcribe it without putting it on the map. ' +
          'You can import <b>multiple CSV files</b> (e.g. several counties) — they merge together.'));
        c.appendChild(infoBox(
          '💡 <b>Recommended: only check dispatch talkgroups.</b> Dispatch channels are where street addresses are announced, ' +
          'so they\'re what actually produces map plots. Mapping tactical/ops/event channels mostly adds noise and extra AI work ' +
          'for little benefit. Use the <b>“Check dispatch only”</b> button below to auto-select them.', 'warn'));
        c.appendChild(infoBox(
          '📡 <b>Monitoring multiple systems?</b> Talkgroup IDs are only unique <i>within</i> a radio system — two systems can both ' +
          'use ID 101 for completely different channels. Set the <b>System name</b> below to match exactly what your radio source sends ' +
          '(SDRTrunk system name / TrunkRecorder <code>shortName</code> / rdio-scanner system label), then import that system\'s CSV(s). ' +
          'Repeat per system. Leave it blank only if you run a single system.'));

        // System name for this import batch
        const sysField = el('div', { class: 'field' });
        sysField.appendChild(el('label', {}, 'System name for this import (match your radio source\'s system label)'));
        const systemInput = el('input', { type: 'text', placeholder: 'e.g. Montgomery P25  (leave blank for single-system)' });
        sysField.appendChild(systemInput);
        sysField.appendChild(el('div', { class: 'hint' }, 'Case-insensitive. Must match the system label sent with each call so the bot maps it to the right talkgroup.'));
        c.appendChild(sysField);

        // Upload
        const f = el('div', { class: 'field' });
        f.appendChild(el('label', {}, 'Import RadioReference CSV file(s)'));
        const fileInput = el('input', { type: 'file', accept: '.csv', multiple: 'multiple' });
        f.appendChild(fileInput);
        f.appendChild(el('div', { class: 'hint' }, 'Columns: DEC, HEX, Alpha Tag, Mode, Description, Tag, County. Select multiple files at once if needed. They\'ll be imported under the System name above.'));
        c.appendChild(f);

        // Imported-systems overview
        const sysOverview = el('div', { class: 'hint', style: 'margin:6px 0 2px' });
        c.appendChild(sysOverview);

        const status = el('div', { class: 'result' });
        c.appendChild(status);

        // Controls: search / county filter / sort / clear / select helpers
        const controls = el('div', { class: 'tg-controls' });
        const searchInput = el('input', { type: 'text', placeholder: '🔍 Search alpha tag, description, or ID…' });
        const systemSel = el('select');
        systemSel.appendChild(el('option', { value: '' }, 'All systems'));
        const countySel = el('select');
        countySel.appendChild(el('option', { value: '' }, 'All counties'));
        const sortSel = el('select');
        [['id', 'Sort: ID'], ['alpha', 'Sort: Alpha tag'], ['county', 'Sort: County'], ['tag', 'Sort: Tag'], ['system', 'Sort: System']].forEach(([v, t]) => sortSel.appendChild(el('option', { value: v }, t)));
        controls.appendChild(searchInput);
        controls.appendChild(systemSel);
        controls.appendChild(countySel);
        controls.appendChild(sortSel);
        c.appendChild(controls);

        const bulk = el('div', { class: 'tg-bulk' });
        const selCount = el('span', { class: 'sel-count' }, '');
        const dispatchBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, '✓ Check dispatch only');
        const selAllBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Check all shown');
        const clearSelBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Uncheck all');
        const clearDbBtn = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'Delete all imported');
        bulk.appendChild(dispatchBtn); bulk.appendChild(selAllBtn); bulk.appendChild(clearSelBtn); bulk.appendChild(clearDbBtn); bulk.appendChild(selCount);
        c.appendChild(bulk);

        const tableWrap = el('div', { class: 'tg-table-wrap', style: 'display:none' });
        c.appendChild(tableWrap);

        const selected = new Set((get('MAPPED_TALK_GROUPS') || '').split(',').map((s) => s.trim()).filter(Boolean));
        const updateSelState = () => {
          set('MAPPED_TALK_GROUPS', Array.from(selected).join(','));
          set('ENABLE_MAPPED_TALK_GROUPS', 'true');
          selCount.textContent = `${selected.size} talkgroup(s) selected for mapping`;
        };
        updateSelState();

        // A mapping key is system-scoped when the row has a system, so the same
        // id on different systems can be mapped independently. Single-system
        // (blank system) keeps using the plain id for backward compatibility.
        const keyFor = (r) => (r.system ? `${r.system}:${r.id}` : String(r.id));

        let currentRows = [];
        const renderTable = (rows) => {
          currentRows = rows;
          if (!rows.length) { tableWrap.style.display = 'none'; return; }
          tableWrap.style.display = 'block';
          const table = el('table');
          table.innerHTML = '<thead><tr><th>Map?</th><th>System</th><th>ID</th><th>Alpha Tag</th><th>Description</th><th>County</th></tr></thead>';
          const tbody = el('tbody');
          rows.forEach((r) => {
            const id = String(r.id);
            const key = keyFor(r);
            const tr = el('tr');
            const cb = el('input', { type: 'checkbox' });
            cb.checked = selected.has(key);
            cb.addEventListener('change', () => { cb.checked ? selected.add(key) : selected.delete(key); updateSelState(); });
            const td0 = el('td'); td0.appendChild(cb); tr.appendChild(td0);
            [r.system || '—', id, r.alpha_tag || '', r.description || '', r.county || ''].forEach((v) => tr.appendChild(el('td', {}, String(v).replace(/</g, '&lt;'))));
            tbody.appendChild(tr);
          });
          table.appendChild(tbody);
          tableWrap.innerHTML = '';
          tableWrap.appendChild(table);
        };

        const load = () => {
          const params = new URLSearchParams({ search: searchInput.value.trim(), county: countySel.value, system: systemSel.value, sort: sortSel.value, limit: '2000' });
          api('/api/setup/talkgroups?' + params).then((d) => {
            renderTable(d.talkgroups || []);
            if (d.total > (d.talkgroups || []).length) status.textContent = `Showing ${d.talkgroups.length} of ${d.total} talkgroups (refine search)`;
          });
        };
        const loadCounties = () => api('/api/setup/talkgroup-counties').then((d) => {
          const cur = countySel.value;
          countySel.innerHTML = '';
          countySel.appendChild(el('option', { value: '' }, 'All counties'));
          (d.counties || []).forEach((c2) => countySel.appendChild(el('option', { value: c2 }, c2)));
          countySel.value = cur;
        });
        const loadSystems = () => api('/api/setup/talkgroup-systems').then((d) => {
          const cur = systemSel.value;
          systemSel.innerHTML = '';
          systemSel.appendChild(el('option', { value: '' }, 'All systems'));
          const systems = d.systems || [];
          systems.forEach((s) => systemSel.appendChild(el('option', { value: s.system }, `${s.system || '(single system)'} — ${s.count}`)));
          systemSel.value = cur;
          // Overview line under the upload control
          if (systems.length) {
            sysOverview.innerHTML = 'Imported systems: ' + systems.map((s) => `<b>${(s.system || '(single)').replace(/</g, '&lt;')}</b> (${s.count})`).join(' · ');
          } else {
            sysOverview.textContent = '';
          }
        });

        let searchTimer = null;
        searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 250); });
        systemSel.addEventListener('change', load);
        countySel.addEventListener('change', load);
        sortSel.addEventListener('change', load);
        dispatchBtn.addEventListener('click', async () => {
          dispatchBtn.disabled = true;
          const prev = dispatchBtn.textContent;
          dispatchBtn.textContent = 'Finding dispatch…';
          try {
            // Respect ALL active filters (search/county/system) so e.g. filtering
            // by "fire" then clicking this only checks the shown fire dispatch
            // channels — not every dispatch talkgroup in the database.
            const p = new URLSearchParams({
              search: searchInput.value.trim(),
              county: countySel.value,
              system: systemSel.value,
              limit: '10000',
            });
            const d = await api('/api/setup/talkgroups?' + p);
            const inView = d.talkgroups || [];
            // Mirror the server's "dispatch" match across alpha tag / description / tag / id.
            const isDispatch = (r) => /dispatch/i.test(`${r.alpha_tag || ''} ${r.description || ''} ${r.tag || ''} ${r.id || ''}`);
            const found = inView.filter(isDispatch);
            found.forEach((r) => selected.add(keyFor(r)));
            updateSelState();
            load();
            const scope = (searchInput.value.trim() || countySel.value || systemSel.value) ? ' in current filter' : '';
            toast(`Checked ${found.length} dispatch talkgroup(s)${scope}`, 'ok');
          } catch (e) { toast('Failed: ' + e.message, 'err'); }
          finally { dispatchBtn.disabled = false; dispatchBtn.textContent = prev; }
        });
        selAllBtn.addEventListener('click', () => { currentRows.forEach((r) => selected.add(keyFor(r))); updateSelState(); load(); });
        clearSelBtn.addEventListener('click', () => { selected.clear(); updateSelState(); load(); });
        clearDbBtn.addEventListener('click', async () => {
          // Clear just the filtered system if one is selected, otherwise everything.
          const sys = systemSel.value;
          const msg = sys
            ? `Delete imported talkgroups for system "${sys}"? This cannot be undone.`
            : 'Delete ALL imported talkgroups (every system)? This cannot be undone.';
          if (!confirm(msg)) return;
          await api('/api/setup/talkgroups/clear', { method: 'POST', body: JSON.stringify({ system: sys || '__all__' }), headers: { 'Content-Type': 'application/json' } });
          selected.clear(); updateSelState(); loadSystems(); loadCounties(); load();
          toast(sys ? `Cleared system "${sys}"` : 'All talkgroups cleared', 'ok');
        });

        fileInput.addEventListener('change', async () => {
          if (!fileInput.files.length) return;
          status.className = 'result pending';
          const sysName = systemInput.value.trim();
          status.textContent = `Uploading ${fileInput.files.length} file(s)${sysName ? ` for system "${sysName}"` : ''}…`;
          const fd = new FormData();
          Array.from(fileInput.files).forEach((file) => fd.append('files', file));
          fd.append('system', sysName);
          try {
            const res = await fetch('/api/setup/upload-talkgroups', { method: 'POST', body: fd, headers: authHeaders() });
            const j = await res.json();
            if (j.ok) {
              status.className = 'result ok';
              status.textContent = `✓ Imported ${j.count} talkgroups${j.system ? ` into system "${j.system}"` : ''}`;
              loadSystems(); loadCounties(); load();
            } else {
              status.className = 'result err'; status.textContent = '✗ ' + (j.error || 'Import failed');
            }
          } catch (e) { status.className = 'result err'; status.textContent = '✗ ' + e.message; }
        });

        loadSystems();
        loadCounties();
        load();
      },
    },

    // 9 — Target Cities
    {
      title: 'Target Cities',
      render(c) {
        c.appendChild(el('h1', {}, 'Target Cities'));
        c.appendChild(el('p', { class: 'lead' }, 'Cities that the geocoder is allowed to plot. This keeps calls inside your real coverage area.'));
        c.appendChild(infoBox(
          '<b>Important:</b> if this list is non-empty, only addresses in these cities will be placed on the map — ' +
          'calls resolving to cities <b>not</b> in the list are skipped (not plotted). Leave it empty to allow all cities in your target counties.'));

        const counties = (get('GEOCODING_TARGET_COUNTIES') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const fetchRow = el('div', { class: 'test-row' });
        const fetchBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, '✨ Auto-fetch cities from my counties');
        const fetchResult = el('span', { class: 'result' });
        fetchRow.appendChild(fetchBtn); fetchRow.appendChild(fetchResult);
        c.appendChild(fetchRow);
        c.appendChild(el('div', { class: 'hint' }, counties.length ? `Counties: ${counties.join(', ')} (${get('GEOCODING_STATE')})` : 'Set your target counties on the Map & Location step first.'));

        const selected = new Set((get('TARGET_CITIES_LIST') || '').split(',').map((s) => s.trim()).filter(Boolean));
        const listWrap = el('div', { class: 'cities-wrap' });
        c.appendChild(listWrap);

        const manualRow = el('div', { class: 'test-row', style: 'margin-top:10px' });
        const manualInput = el('input', { type: 'text', placeholder: 'Add a city manually…', style: 'flex:1' });
        const addBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Add');
        manualRow.appendChild(manualInput); manualRow.appendChild(addBtn);
        c.appendChild(manualRow);

        const sync = () => set('TARGET_CITIES_LIST', Array.from(selected).join(','));
        const renderList = () => {
          listWrap.innerHTML = '';
          if (!selected.size) { listWrap.appendChild(el('div', { class: 'hint' }, 'No cities selected — all cities in your counties will be allowed.')); return; }
          Array.from(selected).sort().forEach((city) => {
            const chip = el('span', { class: 'city-chip' });
            chip.appendChild(el('span', {}, city));
            const x = el('button', { class: 'chip-x', type: 'button' }, '×');
            x.addEventListener('click', () => { selected.delete(city); sync(); renderList(); });
            chip.appendChild(x);
            listWrap.appendChild(chip);
          });
        };
        renderList();

        addBtn.addEventListener('click', () => {
          const v = manualInput.value.trim();
          if (v) { selected.add(v); sync(); renderList(); manualInput.value = ''; }
        });
        manualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });

        fetchBtn.addEventListener('click', async () => {
          if (!counties.length) { fetchResult.className = 'result err'; fetchResult.textContent = '✗ Set target counties first'; return; }
          fetchResult.className = 'result pending';
          fetchResult.textContent = 'Fetching from OpenStreetMap… (can take 20–40s)';
          fetchBtn.disabled = true;
          try {
            const r = await api('/api/setup/cities-in-counties', { method: 'POST', body: JSON.stringify({ state: get('GEOCODING_STATE'), counties }) });
            if (r.ok && r.cities.length) {
              r.cities.forEach((c2) => selected.add(c2));
              sync(); renderList();
              fetchResult.className = 'result ok';
              fetchResult.textContent = `✓ Added ${r.cities.length} cities (all selected — uncheck any you don't want)`;
            } else {
              fetchResult.className = 'result err';
              fetchResult.textContent = '✗ ' + (r.error || 'No cities found. Add them manually.');
            }
          } catch (e) {
            fetchResult.className = 'result err'; fetchResult.textContent = '✗ ' + e.message;
          } finally { fetchBtn.disabled = false; }
        });
      },
    },

    // 10 — Review & Finish (+ API key)
    {
      title: 'Review & Finish',
      render(c) {
        c.appendChild(el('h1', {}, 'Review & Finish'));
        c.appendChild(el('p', { class: 'lead' }, 'Double-check everything, then finish. Secrets show as “set”.'));
        const grid = el('div', { class: 'review-grid' });
        const add = (k, v, secret) => {
          grid.appendChild(el('div', { class: 'k' }, k));
          if (secret) grid.appendChild(el('div', { class: 'v' }, v ? '<span class="badge set">set</span>' : '<span class="badge">not set</span>'));
          else grid.appendChild(el('div', { class: 'v' }, (v || '—')));
        };
        add('Mode', String(get('MAP_ONLY_MODE')).toLowerCase() === 'true' ? 'Web map only' : 'Discord + web map');
        add('Location', `${get('GEOCODING_CITY')}, ${get('GEOCODING_STATE')}`);
        add('Map center', get('MAP_CENTER_LAT') ? `${get('MAP_CENTER_LAT')}, ${get('MAP_CENTER_LON')}` : 'default');
        add('Geocoding', get('__geo_provider'));
        add('Transcription', get('TRANSCRIPTION_MODE'));
        add('AI provider', get('AI_PROVIDER'));
        add('Storage', get('STORAGE_MODE'));
        add('Web port', get('WEBSERVER_PORT', '80'));
        add('Upload port', get('BOT_PORT', '3306'));
        add('Auth', String(get('ENABLE_AUTH')).toLowerCase() === 'true' ? 'Enabled' : 'Disabled');
        add('Discord token', get('DISCORD_TOKEN') || state['__secretSet_DISCORD_TOKEN'], true);
        add('Mapped talkgroups', (get('MAPPED_TALK_GROUPS') || '').split(',').filter(Boolean).length + ' selected');
        add('Target cities', (get('TARGET_CITIES_LIST') || '').split(',').filter(Boolean).length + ' (0 = all)');
        c.appendChild(grid);
      },
    },
  ];

  // ---- Extra steps for Settings mode (API keys, Health) -------------------
  const apiKeysStep = {
    title: 'API Keys',
    render(c) {
      c.appendChild(el('h1', {}, 'Upload API Keys'));
      c.appendChild(el('p', { class: 'lead' }, 'Scanners authenticate to the upload port with these keys.'));
      c.appendChild(infoBox(
        'Paste a key into the <b>API key</b> setting of SDRTrunk, TrunkRecorder, or rdio-scanner. ' +
        'Keys are stored hashed for verification; the plaintext is kept locally so you can view it here. ' +
        'If a key shows as <b>hidden</b>, it was created before this feature — just regenerate to get a fresh visible one.'));
      const list = el('div', { class: 'apikey-list' }, 'Loading…');
      c.appendChild(list);

      const genRow = el('div', { class: 'test-row', style: 'margin-top:16px' });
      const nameInput = el('input', { type: 'text', placeholder: 'Key name (e.g. SDRTrunk-1)', value: 'Default', style: 'flex:1' });
      const genBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Generate / Regenerate');
      genRow.appendChild(nameInput); genRow.appendChild(genBtn);
      c.appendChild(genRow);
      const genResult = el('div', {});
      c.appendChild(genResult);

      const load = () => api('/api/setup/apikeys').then((d) => {
        list.innerHTML = '';
        if (!d.keys || !d.keys.length) { list.appendChild(el('div', { class: 'hint' }, 'No keys yet — generate one below.')); return; }
        d.keys.forEach((k) => {
          const card = el('div', { class: 'apikey-card', style: 'margin:0 0 12px' });
          card.appendChild(el('div', { class: 'apikey-title' }, `🔑 ${k.name}${k.disabled ? ' (disabled)' : ''}`));
          card.appendChild(el('div', { class: 'apikey-desc' }, `Created ${k.created_at ? new Date(k.created_at).toLocaleString() : 'unknown'}`));
          const row = el('div', { class: 'apikey-row' });
          const input = el('input', { type: 'text', readonly: 'readonly', value: k.key || '•••••••• (hidden — regenerate to reveal)' });
          row.appendChild(input);
          if (k.key) {
            const copy = el('button', { class: 'btn btn-sm', type: 'button' }, 'Copy');
            copy.addEventListener('click', () => { input.select(); navigator.clipboard?.writeText(k.key); toast('Copied', 'ok'); });
            row.appendChild(copy);
          }
          card.appendChild(row);
          list.appendChild(card);
        });
      });

      genBtn.addEventListener('click', async () => {
        const r = await api('/api/setup/apikeys/generate', { method: 'POST', body: JSON.stringify({ name: nameInput.value.trim() || 'Default' }) });
        if (r.ok) { genResult.innerHTML = ''; genResult.appendChild(renderApiKeyCard(r.key)); load(); toast('Key generated', 'ok'); }
        else toast(r.error || 'Failed', 'err');
      });
      load();
    },
  };

  const healthStep = {
    title: 'Health',
    render(c) {
      c.appendChild(el('h1', {}, 'System Health'));
      c.appendChild(el('p', { class: 'lead' }, 'Live status of the components Scanner Map depends on.'));
      const refresh = el('button', { class: 'btn btn-sm', type: 'button' }, '↻ Refresh');
      c.appendChild(refresh);
      const list = el('ul', { class: 'health-list', style: 'margin-top:14px' }, '<li>Checking…</li>');
      c.appendChild(list);
      const run = () => api('/api/setup/health').then((h) => {
        list.innerHTML = '';
        const item = (ok, name, meta) => {
          const li = el('li');
          li.appendChild(el('span', { class: 'status' }, ok ? '✅' : '⚠️'));
          li.appendChild(el('span', {}, name));
          li.appendChild(el('span', { class: 'meta' }, meta || ''));
          list.appendChild(li);
        };
        item(true, 'Node.js', h.node.version);
        item(h.python.ok, 'Python', h.python.ok ? h.python.version : 'Not found');
        item(h.ffmpeg.ok, 'FFmpeg', h.ffmpeg.ok ? 'installed' : 'Not found');
        item(h.diskWritable, 'Data directory writable', h.diskWritable ? 'ok' : 'check permissions');
        item(true, 'System', `${h.platform} · ${h.cpus} CPU · ${h.memoryGB} GB RAM`);
      });
      refresh.addEventListener('click', run);
      run();
    },
  };

  // Safe admin fetch that tolerates non-JSON error bodies (e.g. 401 text).
  async function adminFetch(path, opts = {}) {
    const headers = authHeaders({ 'Content-Type': 'application/json', ...(opts.headers || {}) });
    const res = await fetch(path, { ...opts, headers });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    return { ok: res.ok, status: res.status, data };
  }

  // ---- Discord Tools ------------------------------------------------------
  const discordStep = {
    title: 'Discord Tools',
    render(c) {
      c.appendChild(el('h1', {}, 'Discord Tools'));
      c.appendChild(el('p', { class: 'lead' }, 'Filter, sort, and select the bot\'s channels and categories to delete.'));
      c.appendChild(infoBox(
        'Tick the boxes next to channels and/or categories, then <b>Delete selected</b>. Deleting a category also deletes the ' +
        'channels inside it (toggle below). Deletions are <b>permanent</b> and run rate-limit aware.', 'warn'));

      let allChannels = [];
      let allCategories = [];
      const selChannels = new Set();
      const selCategories = new Set();

      // Filters / sort row
      const controls = el('div', { class: 'tg-controls' });
      const search = el('input', { type: 'text', placeholder: '🔍 Filter by channel or category…' });
      const catFilter = el('select');
      const sortSel = el('select');
      [['cat', 'Sort: Category, then name'], ['name', 'Sort: Channel name (A→Z)'], ['namerev', 'Sort: Channel name (Z→A)'], ['catrev', 'Sort: Category (Z→A)']]
        .forEach(([v, l]) => { const o = el('option', { value: v }); o.textContent = l; sortSel.appendChild(o); });
      const refresh = el('button', { class: 'btn btn-sm', type: 'button' }, '↻ Refresh');
      controls.appendChild(search); controls.appendChild(catFilter); controls.appendChild(sortSel); controls.appendChild(refresh);
      c.appendChild(controls);

      // Option: also delete channels inside selected categories
      const childToggle = el('input', { type: 'checkbox' });
      childToggle.checked = true;
      const childLbl = el('label', { style: 'display:flex;align-items:center;gap:8px;margin:10px 0' });
      childLbl.appendChild(childToggle);
      childLbl.appendChild(document.createTextNode(' Also delete channels inside selected categories'));
      c.appendChild(childLbl);

      // Bulk actions
      const bulk = el('div', { class: 'tg-bulk' });
      const selAll = el('button', { class: 'btn btn-sm', type: 'button' }, '☑ Select all (filtered)');
      const selNone = el('button', { class: 'btn btn-sm', type: 'button' }, '☐ Clear selection');
      const cleanupBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '🧹 Remove empty channels');
      const delBtn = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, '🗑 Delete selected');
      bulk.appendChild(selAll); bulk.appendChild(selNone); bulk.appendChild(cleanupBtn); bulk.appendChild(delBtn);
      c.appendChild(bulk);

      const countLbl = el('div', { class: 'hint' }, '');
      c.appendChild(countLbl);

      c.appendChild(el('h2', { style: 'margin:14px 0 4px' }, 'Categories'));
      const catWrap = el('div', { class: 'tg-table-wrap' }, 'Loading…');
      c.appendChild(catWrap);
      c.appendChild(el('h2', { style: 'margin:14px 0 4px' }, 'Channels'));
      const wrap = el('div', { class: 'tg-table-wrap' }, 'Loading channels…');
      c.appendChild(wrap);

      const updateCount = () => {
        countLbl.textContent = `${selChannels.size} channel(s) and ${selCategories.size} category(ies) selected`;
        delBtn.disabled = !(selChannels.size || selCategories.size);
      };

      const filteredChannels = () => {
        const q = search.value.trim().toLowerCase();
        const cf = catFilter.value;
        const rows = allChannels.filter((ch) => {
          if (cf === '__none__' && ch.parentId) return false;
          if (cf && cf !== '__all__' && cf !== '__none__' && ch.parentId !== cf) return false;
          if (q && !(`${ch.name} ${ch.category || ''}`.toLowerCase().includes(q))) return false;
          return true;
        });
        const s = sortSel.value;
        rows.sort((a, b) => {
          if (s === 'name') return a.name.localeCompare(b.name);
          if (s === 'namerev') return b.name.localeCompare(a.name);
          if (s === 'catrev') return (b.category || '').localeCompare(a.category || '') || a.name.localeCompare(b.name);
          return (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name);
        });
        return rows;
      };

      const renderCats = () => {
        catWrap.innerHTML = '';
        if (!allCategories.length) { catWrap.textContent = 'No categories.'; return; }
        const table = el('table');
        table.innerHTML = '<thead><tr><th></th><th>Category</th><th>Channels</th></tr></thead>';
        const tb = el('tbody');
        allCategories.forEach((cat) => {
          const tr = el('tr');
          const cbtd = el('td');
          const cb = el('input', { type: 'checkbox' });
          cb.checked = selCategories.has(cat.id);
          cb.addEventListener('change', () => { if (cb.checked) selCategories.add(cat.id); else selCategories.delete(cat.id); updateCount(); });
          cbtd.appendChild(cb); tr.appendChild(cbtd);
          const nameTd = el('td'); nameTd.textContent = cat.name; tr.appendChild(nameTd);
          tr.appendChild(el('td', {}, String(cat.channelCount)));
          tb.appendChild(tr);
        });
        table.appendChild(tb); catWrap.appendChild(table);
      };

      const renderChannels = () => {
        const rows = filteredChannels();
        wrap.innerHTML = '';
        if (!rows.length) { wrap.textContent = 'No channels match your filters.'; return; }
        const table = el('table');
        table.innerHTML = '<thead><tr><th></th><th>Category</th><th>Channel</th></tr></thead>';
        const tb = el('tbody');
        rows.forEach((ch) => {
          const tr = el('tr');
          const cbtd = el('td');
          const cb = el('input', { type: 'checkbox' });
          cb.checked = selChannels.has(ch.id);
          cb.addEventListener('change', () => { if (cb.checked) selChannels.add(ch.id); else selChannels.delete(ch.id); updateCount(); });
          cbtd.appendChild(cb); tr.appendChild(cbtd);
          const catTd = el('td'); catTd.textContent = ch.category || '—'; tr.appendChild(catTd);
          const nameTd = el('td'); nameTd.textContent = '#' + ch.name; tr.appendChild(nameTd);
          tb.appendChild(tr);
        });
        table.appendChild(tb); wrap.appendChild(table);
      };

      const renderAll = () => { renderCats(); renderChannels(); updateCount(); };

      const load = async () => {
        wrap.textContent = 'Loading channels…';
        const r = await adminFetch('/api/setup/discord/channels');
        if (!r.data || !r.data.ok) { wrap.textContent = (r.data && r.data.error) || 'Could not load channels.'; catWrap.textContent = ''; return; }
        allChannels = r.data.channels || [];
        allCategories = r.data.categories || [];
        // Rebuild category filter dropdown
        catFilter.innerHTML = '';
        const optAll = el('option', { value: '__all__' }); optAll.textContent = 'All categories'; catFilter.appendChild(optAll);
        const optNone = el('option', { value: '__none__' }); optNone.textContent = '(Uncategorized)'; catFilter.appendChild(optNone);
        allCategories.forEach((cat) => { const o = el('option', { value: cat.id }); o.textContent = `${cat.name} (${cat.channelCount})`; catFilter.appendChild(o); });
        // Drop selections that no longer exist
        const chIds = new Set(allChannels.map((x) => x.id));
        const catIds = new Set(allCategories.map((x) => x.id));
        Array.from(selChannels).forEach((id) => { if (!chIds.has(id)) selChannels.delete(id); });
        Array.from(selCategories).forEach((id) => { if (!catIds.has(id)) selCategories.delete(id); });
        renderAll();
      };

      search.addEventListener('input', renderChannels);
      catFilter.addEventListener('change', renderChannels);
      sortSel.addEventListener('change', renderChannels);
      refresh.addEventListener('click', load);

      selAll.addEventListener('click', () => { filteredChannels().forEach((ch) => selChannels.add(ch.id)); renderChannels(); updateCount(); });
      selNone.addEventListener('click', () => { selChannels.clear(); selCategories.clear(); renderAll(); });

      delBtn.addEventListener('click', async () => {
        if (!selChannels.size && !selCategories.size) { toast('Nothing selected', 'err'); return; }
        const childInfo = (selCategories.size && childToggle.checked) ? ' plus the channels inside those categories' : '';
        if (!confirm(`Permanently delete ${selChannels.size} channel(s) and ${selCategories.size} category(ies)${childInfo}?\n\nThis cannot be undone.`)) return;
        delBtn.disabled = true; delBtn.textContent = 'Deleting…';
        const rr = await adminFetch('/api/setup/discord/delete', { method: 'POST', body: JSON.stringify({
          channelIds: Array.from(selChannels),
          categoryIds: Array.from(selCategories),
          deleteCategoryChildren: childToggle.checked,
          confirm: true,
        }) });
        if (rr.data && rr.data.ok) {
          toast(`Deleted ${rr.data.removedChannels} channel(s), ${rr.data.removedCategories} category(ies)`, 'ok');
          if (rr.data.errors && rr.data.errors.length) { console.warn('Discord delete errors:', rr.data.errors); toast(`${rr.data.errors.length} item(s) could not be deleted (see console)`, 'err'); }
        } else {
          toast((rr.data && rr.data.error) || 'Delete failed', 'err');
        }
        selChannels.clear(); selCategories.clear();
        delBtn.textContent = '🗑 Delete selected';
        load();
      });

      cleanupBtn.addEventListener('click', async () => {
        const dry = await adminFetch('/api/setup/discord/cleanup-empty', { method: 'POST', body: JSON.stringify({ confirm: false }) });
        const cands = (dry.data && dry.data.candidates) || [];
        if (!cands.length) { toast('No empty channels found', 'ok'); return; }
        if (!confirm(`Delete ${cands.length} empty channel(s)?\n\n${cands.map((x) => '#' + x.name).join(', ')}`)) return;
        const rr = await adminFetch('/api/setup/discord/cleanup-empty', { method: 'POST', body: JSON.stringify({ confirm: true }) });
        toast(rr.data && rr.data.ok ? `Removed ${rr.data.removed} channel(s)` : 'Failed', rr.data && rr.data.ok ? 'ok' : 'err');
        load();
      });

      load();
    },
  };

  // ---- Manual Plot --------------------------------------------------------
  const plotStep = {
    title: 'Manual Plot',
    render(c) {
      c.appendChild(el('h1', {}, 'Manually Plot Calls'));
      c.appendChild(el('p', { class: 'lead' }, 'Browse transcribed calls that have no map location and pin them by address or coordinates.'));
      c.appendChild(infoBox('Type an address to geocode it, or paste <code>lat, lon</code> directly. Saving places the call on the map immediately.'));

      const searchRow = el('div', { class: 'tg-controls' });
      const search = el('input', { type: 'text', placeholder: '🔍 Filter transcripts…' });
      const refresh = el('button', { class: 'btn btn-sm', type: 'button' }, '↻ Refresh');
      searchRow.appendChild(search); searchRow.appendChild(refresh);
      c.appendChild(searchRow);

      const list = el('div', { class: 'tg-table-wrap' }, 'Loading…');
      c.appendChild(list);

      const load = async () => {
        list.textContent = 'Loading…';
        const r = await adminFetch('/api/setup/unplotted?' + new URLSearchParams({ search: search.value.trim(), limit: '100' }));
        const calls = (r.data && r.data.calls) || [];
        if (!calls.length) { list.innerHTML = '<div class="hint">No unplotted transcribed calls. 🎉</div>'; return; }
        list.innerHTML = '';
        calls.forEach((call) => {
          const card = el('div', { class: 'apikey-card', style: 'margin:0 0 10px' });
          card.appendChild(el('div', { class: 'apikey-title' }, `${(call.talk_group_name || ('TG ' + call.talk_group_id))}${call.system ? ' [' + call.system + ']' : ''}`));
          card.appendChild(el('div', { class: 'apikey-desc' }, String(call.transcription || '').replace(/</g, '&lt;')));
          const row = el('div', { class: 'apikey-row' });
          const addr = el('input', { type: 'text', placeholder: 'Address or "lat, lon"', value: call.address || '' });
          const geoBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Find');
          const saveBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Save');
          const coord = el('span', { class: 'hint', style: 'margin-left:8px' }, '');
          let lat = null; let lon = null;
          const tryParseLatLon = (v) => {
            const m = v.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
            if (m) { lat = parseFloat(m[1]); lon = parseFloat(m[2]); return true; }
            return false;
          };
          geoBtn.addEventListener('click', async () => {
            if (tryParseLatLon(addr.value)) { coord.textContent = `→ ${lat.toFixed(5)}, ${lon.toFixed(5)}`; return; }
            geoBtn.disabled = true; geoBtn.textContent = '…';
            const g = await api('/api/setup/geocode-search?q=' + encodeURIComponent(addr.value));
            if (g && g.lat != null) { lat = g.lat; lon = g.lon; coord.textContent = `→ ${g.label || ''} (${(+lat).toFixed(5)}, ${(+lon).toFixed(5)})`; }
            else { coord.textContent = 'No match'; }
            geoBtn.disabled = false; geoBtn.textContent = 'Find';
          });
          saveBtn.addEventListener('click', async () => {
            if (lat == null && !tryParseLatLon(addr.value)) { toast('Find a location first', 'err'); return; }
            const rr = await adminFetch('/api/setup/plot', { method: 'POST', body: JSON.stringify({ id: call.id, lat, lon, address: addr.value }) });
            if (rr.data && rr.data.ok) { toast('Plotted on map', 'ok'); card.style.opacity = '0.5'; saveBtn.disabled = true; }
            else { toast((rr.data && rr.data.error) || 'Failed', 'err'); }
          });
          row.appendChild(addr); row.appendChild(geoBtn); row.appendChild(saveBtn);
          card.appendChild(row); card.appendChild(coord);
          list.appendChild(card);
        });
      };
      let t = null;
      search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
      refresh.addEventListener('click', load);
      load();
    },
  };

  // ---- Maintenance --------------------------------------------------------
  const maintenanceStep = {
    title: 'Maintenance',
    render(c) {
      c.appendChild(el('h1', {}, 'Maintenance'));
      c.appendChild(el('p', { class: 'lead' }, 'Database statistics, backups, and log viewer.'));

      const stats = el('ul', { class: 'health-list' }, '<li>Loading stats…</li>');
      c.appendChild(stats);
      const fmtTime = (t) => (t ? new Date(t * 1000).toLocaleString() : '—');
      adminFetch('/api/setup/db-stats').then((r) => {
        const d = r.data || {};
        stats.innerHTML = '';
        const item = (name, val) => { const li = el('li'); li.appendChild(el('span', {}, name)); li.appendChild(el('span', { class: 'meta' }, String(val))); stats.appendChild(li); };
        item('App version', d.version || '—');
        item('Database size', (d.dbSizeMB != null ? d.dbSizeMB + ' MB' : '—'));
        item('Total calls', d.totalCalls != null ? d.totalCalls : '—');
        item('Transcribed', d.transcribedCalls != null ? d.transcribedCalls : '—');
        item('Plotted on map', d.plottedCalls != null ? d.plottedCalls : '—');
        item('Calls (last 24h)', d.last24h != null ? d.last24h : '—');
        item('Talkgroups imported', d.talkgroups != null ? d.talkgroups : '—');
        item('Systems', d.systems != null ? d.systems : '—');
        item('Oldest call', fmtTime(d.oldest));
        item('Newest call', fmtTime(d.newest));
      });

      c.appendChild(el('h1', { style: 'font-size:18px;margin-top:18px' }, 'Backup'));
      const backup = el('a', { class: 'btn btn-primary', href: '/api/setup/backup-db' + (authToken ? '?token=' + encodeURIComponent(authToken) : '') }, '⬇ Download database backup');
      c.appendChild(backup);
      c.appendChild(el('div', { class: 'hint', style: 'margin-top:6px' }, 'Saves a copy of botdata.db. Keep regular backups before updates.'));

      c.appendChild(el('h1', { style: 'font-size:18px;margin-top:18px' }, 'Logs'));
      const logSel = el('select');
      const tail = el('button', { class: 'btn btn-sm', type: 'button', style: 'margin-left:8px' }, '↻ View');
      const logRow = el('div', { class: 'tg-bulk' });
      logRow.appendChild(logSel); logRow.appendChild(tail);
      c.appendChild(logRow);
      const pre = el('pre', { class: 'log-view', style: 'max-height:340px;overflow:auto;background:#0a0f0a;color:#9f9;padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap' }, '');
      c.appendChild(pre);
      adminFetch('/api/setup/logs').then((r) => {
        (((r.data || {}).logs) || []).forEach((l) => logSel.appendChild(el('option', { value: l.name }, `${l.name} (${l.sizeKB} KB)`)));
      });
      const viewLog = async () => {
        const r = await adminFetch('/api/setup/log-tail?' + new URLSearchParams({ name: logSel.value || 'combined.log', lines: '300' }));
        pre.textContent = (r.data && r.data.lines) ? r.data.lines.join('\n') : ((r.data && r.data.error) || 'No output');
        pre.scrollTop = pre.scrollHeight;
      };
      tail.addEventListener('click', viewLog);
    },
  };

  // ---- Updates ------------------------------------------------------------
  const updatesStep = {
    title: 'Updates',
    render(c) {
      c.appendChild(el('h1', {}, 'Software Updates'));
      c.appendChild(el('p', { class: 'lead' }, 'Check for and install the latest Scanner Map version.'));
      c.appendChild(infoBox(
        'Updating runs <code>git pull</code>, installs dependencies, and applies database migrations. ' +
        '<b>Back up your database first</b> (Maintenance tab). After a successful update, <b>restart Scanner Map</b> to run the new code.'));

      const info = el('div', { class: 'result' }, 'Checking…');
      c.appendChild(info);
      const changelog = el('pre', { style: 'background:#0a0f0a;color:#9f9;padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap;display:none' });
      c.appendChild(changelog);

      const actions = el('div', { class: 'tg-bulk' });
      const checkBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '↻ Check again');
      const runBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: 'disabled' }, '⬆ Update now');
      actions.appendChild(checkBtn); actions.appendChild(runBtn);
      c.appendChild(actions);

      const out = el('pre', { style: 'background:#0a0f0a;color:#9f9;padding:10px;border-radius:6px;font-size:12px;white-space:pre-wrap;display:none;max-height:300px;overflow:auto' });
      c.appendChild(out);

      const check = async () => {
        info.className = 'result pending'; info.textContent = 'Checking…';
        const r = await adminFetch('/api/setup/update/check');
        const d = r.data || {};
        if (!d.ok) { info.className = 'result err'; info.textContent = '✗ ' + (d.error || 'Check failed'); return; }
        if (!d.gitRepo) { info.className = 'result'; info.textContent = d.message || 'Not a git checkout.'; runBtn.disabled = true; return; }
        if (d.upToDate) { info.className = 'result ok'; info.textContent = `✓ Up to date (v${d.version}, ${d.local}).`; runBtn.disabled = true; changelog.style.display = 'none'; }
        else { info.className = 'result ok'; info.textContent = `⬆ ${d.behind} update(s) available (current ${d.local} → ${d.remote}).`; runBtn.disabled = false;
          if (d.changelog && d.changelog.length) { changelog.style.display = 'block'; changelog.textContent = 'Incoming changes:\n' + d.changelog.join('\n'); } }
      };
      checkBtn.addEventListener('click', check);
      let poll = null;
      runBtn.addEventListener('click', async () => {
        if (!confirm('Update now? Make sure you have a database backup. The app must be restarted afterward.')) return;
        runBtn.disabled = true; out.style.display = 'block'; out.textContent = 'Starting update…';
        const r = await adminFetch('/api/setup/update/run', { method: 'POST', body: '{}' });
        if (!r.data || !r.data.ok) { out.textContent = (r.data && r.data.error) || 'Failed to start'; runBtn.disabled = false; return; }
        poll = setInterval(async () => {
          const s = await adminFetch('/api/setup/update/status');
          const d = s.data || {};
          out.textContent = (d.log || []).join('\n');
          out.scrollTop = out.scrollHeight;
          if (!d.running) { clearInterval(poll); toast(d.code === 0 ? 'Update complete — restart now' : 'Update finished with errors', d.code === 0 ? 'ok' : 'err'); }
        }, 1500);
      });
      check();
    },
  };

  // ---- Users --------------------------------------------------------------
  const usersStep = {
    title: 'Users',
    render(c) {
      c.appendChild(el('h1', {}, 'Users'));
      c.appendChild(el('p', { class: 'lead' }, 'Manage accounts that can log into the map (only relevant when authentication is enabled).'));
      if (String(get('ENABLE_AUTH')).toLowerCase() !== 'true') {
        c.appendChild(infoBox('Authentication is currently <b>disabled</b>. Enable it on the Network &amp; Auth tab to use user accounts.', 'warn'));
      }
      const list = el('div', { class: 'tg-table-wrap' }, 'Loading…');
      c.appendChild(list);

      const addRow = el('div', { class: 'apikey-row', style: 'margin-top:14px' });
      const u = el('input', { type: 'text', placeholder: 'New username' });
      const p = el('input', { type: 'password', placeholder: 'Password' });
      const add = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Add user');
      addRow.appendChild(u); addRow.appendChild(p); addRow.appendChild(add);
      c.appendChild(addRow);

      const load = async () => {
        const r = await adminFetch('/api/users');
        if (!r.ok) { list.innerHTML = `<div class="hint">${(r.data && r.data.error) || 'Could not load users.'}</div>`; return; }
        const users = Array.isArray(r.data) ? r.data : [];
        if (!users.length) { list.innerHTML = '<div class="hint">No users yet.</div>'; return; }
        const table = el('table');
        table.innerHTML = '<thead><tr><th>User</th><th>Created</th><th></th></tr></thead>';
        const tbody = el('tbody');
        users.forEach((user) => {
          const tr = el('tr');
          tr.appendChild(el('td', {}, String(user.username).replace(/</g, '&lt;')));
          tr.appendChild(el('td', {}, user.created_at ? new Date(user.created_at).toLocaleString() : '—'));
          const td = el('td');
          if (user.username !== 'admin') {
            const del = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'Delete');
            del.addEventListener('click', async () => {
              if (!confirm(`Delete user ${user.username}?`)) return;
              const rr = await adminFetch('/api/users/' + user.id, { method: 'DELETE' });
              toast(rr.ok ? 'User deleted' : 'Failed', rr.ok ? 'ok' : 'err'); load();
            });
            td.appendChild(del);
          } else { td.appendChild(el('span', { class: 'hint' }, 'admin')); }
          tr.appendChild(td); tbody.appendChild(tr);
        });
        table.appendChild(tbody); list.innerHTML = ''; list.appendChild(table);
      };
      add.addEventListener('click', async () => {
        if (!u.value.trim() || !p.value) { toast('Username and password required', 'err'); return; }
        const rr = await adminFetch('/api/users', { method: 'POST', body: JSON.stringify({ username: u.value.trim(), password: p.value }) });
        if (rr.ok) { toast('User added', 'ok'); u.value = ''; p.value = ''; load(); }
        else { toast((rr.data && rr.data.error) || 'Failed', 'err'); }
      });
      load();
    },
  };

  // ---- Sessions -----------------------------------------------------------
  const sessionsStep = {
    title: 'Sessions',
    render(c) {
      c.appendChild(el('h1', {}, 'Active Sessions'));
      c.appendChild(el('p', { class: 'lead' }, 'Logged-in devices/browsers. Terminate any you don\'t recognize.'));
      if (String(get('ENABLE_AUTH')).toLowerCase() !== 'true') {
        c.appendChild(infoBox('Authentication is <b>disabled</b>, so there are no sessions to manage.', 'warn'));
        return;
      }
      const list = el('div', { class: 'tg-table-wrap' }, 'Loading…');
      c.appendChild(list);
      const load = async () => {
        const r = await adminFetch('/api/sessions');
        if (!r.ok) { list.innerHTML = `<div class="hint">${(r.data && r.data.error) || 'Could not load sessions.'}</div>`; return; }
        const sessions = Array.isArray(r.data) ? r.data : [];
        if (!sessions.length) { list.innerHTML = '<div class="hint">No active sessions.</div>'; return; }
        const table = el('table');
        table.innerHTML = '<thead><tr><th>User</th><th>Created</th><th>Expires</th><th>Device / IP</th><th></th></tr></thead>';
        const tbody = el('tbody');
        sessions.forEach((s) => {
          const tr = el('tr');
          tr.appendChild(el('td', {}, String(s.username || '—').replace(/</g, '&lt;')));
          tr.appendChild(el('td', {}, s.created_at ? new Date(s.created_at).toLocaleString() : '—'));
          tr.appendChild(el('td', {}, s.expires_at ? new Date(s.expires_at).toLocaleString() : '—'));
          tr.appendChild(el('td', {}, `${String(s.user_agent || 'Unknown').slice(0, 40).replace(/</g, '&lt;')}<br><small>${s.ip_address || ''}</small>`));
          const td = el('td');
          const del = el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, 'Terminate');
          del.addEventListener('click', async () => {
            if (!confirm('Terminate this session?')) return;
            const rr = await adminFetch('/api/sessions/' + encodeURIComponent(s.token), { method: 'DELETE' });
            toast(rr.ok ? 'Session terminated' : 'Failed', rr.ok ? 'ok' : 'err'); load();
          });
          td.appendChild(del); tr.appendChild(td); tbody.appendChild(tr);
        });
        table.appendChild(tbody); list.innerHTML = ''; list.appendChild(table);
      };
      load();
    },
  };

  // ---- Call Purge ---------------------------------------------------------
  const purgeStep = {
    title: 'Call Purge',
    render(c) {
      c.appendChild(el('h1', {}, 'Call Purge'));
      c.appendChild(el('p', { class: 'lead' }, 'Remove plotted calls from the map within a time range (the transcript stays; only the map pin is cleared).'));
      c.appendChild(infoBox('This clears coordinates for matching calls so they leave the map. You can undo the most recent purge.'));

      const presetSel = el('select');
      [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']].forEach(([v, t]) => presetSel.appendChild(el('option', { value: v }, t)));
      const f = el('div', { class: 'field' });
      f.appendChild(el('label', {}, 'Time range to purge'));
      f.appendChild(presetSel);
      c.appendChild(f);

      const range = () => {
        const now = Math.floor(Date.now() / 1000);
        const map = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, all: now };
        return { start: now - (map[presetSel.value] || 86400), end: now };
      };

      const countBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'Preview count');
      const purgeBtn = el('button', { class: 'btn btn-sm btn-danger', type: 'button', style: 'margin-left:8px' }, 'Purge');
      const undoBtn = el('button', { class: 'btn btn-sm', type: 'button', style: 'margin-left:8px' }, '↶ Undo last purge');
      const bulk = el('div', { class: 'tg-bulk' });
      bulk.appendChild(countBtn); bulk.appendChild(purgeBtn); bulk.appendChild(undoBtn);
      c.appendChild(bulk);
      const res = el('div', { class: 'result' });
      c.appendChild(res);

      countBtn.addEventListener('click', async () => {
        const { start, end } = range();
        const r = await adminFetch('/api/calls/purge-count?' + new URLSearchParams({ timeRangeStart: start, timeRangeEnd: end }));
        res.className = 'result'; res.textContent = r.ok ? `${(r.data && r.data.count) || 0} call(s) would be purged.` : ((r.data && r.data.error) || 'Failed');
      });
      purgeBtn.addEventListener('click', async () => {
        const { start, end } = range();
        if (!confirm('Purge matching calls from the map?')) return;
        const r = await adminFetch('/api/calls/purge', { method: 'POST', body: JSON.stringify({ timeRangeStart: start, timeRangeEnd: end }) });
        res.className = r.ok ? 'result ok' : 'result err';
        res.textContent = r.ok ? `Purged ${(r.data && (r.data.purged || r.data.count)) || ''} call(s).` : ((r.data && r.data.error) || 'Failed');
      });
      undoBtn.addEventListener('click', async () => {
        const r = await adminFetch('/api/calls/undo-last-purge', { method: 'POST', body: '{}' });
        res.className = r.ok ? 'result ok' : 'result err';
        res.textContent = r.ok ? 'Last purge undone.' : ((r.data && r.data.error) || 'Nothing to undo');
      });
    },
  };

  // In settings mode: drop "Review & Finish", append the live admin tabs.
  if (SETTINGS_MODE) {
    if (steps[steps.length - 1].title === 'Review & Finish') steps.pop();
    steps.push(
      apiKeysStep, discordStep, plotStep, purgeStep,
      usersStep, sessionsStep, maintenanceStep, updatesStep, healthStep,
    );
  }

  // ---- Local GPU / Python setup widget -----------------------------------
  function renderLocalGpuSetup(c) {
    const box = el('div', { class: 'gpu-box' });
    c.appendChild(box);

    box.appendChild(selectField('TRANSCRIPTION_DEVICE', 'Compute device', [
      ['cuda', 'NVIDIA GPU (CUDA) — fastest'],
      ['cpu', 'CPU — works everywhere, slow'],
      ['mps', 'Apple Silicon (Metal)'],
    ], null, () => {}));

    // GPU detect
    const gpuRow = el('div', { class: 'test-row' });
    const gpuBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '🔍 Detect NVIDIA GPU');
    const gpuRes = el('span', { class: 'result' });
    gpuRow.appendChild(gpuBtn); gpuRow.appendChild(gpuRes);
    box.appendChild(gpuRow);

    // Python interpreter picker
    const pyField = el('div', { class: 'field', style: 'margin-top:12px' });
    pyField.appendChild(el('label', {}, 'Python interpreter (3.8–3.12) for the transcription environment'));
    const pySel = el('select');
    pySel.appendChild(el('option', { value: '' }, 'Detecting Python installs…'));
    pyField.appendChild(pySel);
    pyField.appendChild(el('div', { class: 'hint' }, 'A dedicated virtual environment (.venv) will be created here.'));
    box.appendChild(pyField);

    api('/api/setup/detect-python').then((d) => {
      pySel.innerHTML = '';
      const pys = d.pythons || [];
      if (!pys.length) { pySel.appendChild(el('option', { value: '' }, 'No Python found — install Python 3.11')); return; }
      pys.forEach((p) => {
        const label = `${p.version} ${p.usable ? '' : '(unsupported)'} — ${p.path}`;
        const o = el('option', { value: p.path }, label);
        if (!p.usable) o.disabled = true;
        pySel.appendChild(o);
      });
      const firstUsable = pys.find((p) => p.usable);
      if (firstUsable) { pySel.value = firstUsable.path; set('__basePython', firstUsable.path); }
    });
    pySel.addEventListener('change', () => set('__basePython', pySel.value));

    gpuBtn.addEventListener('click', async () => {
      gpuRes.className = 'result pending'; gpuRes.textContent = 'Checking…';
      const r = await api('/api/setup/detect-gpu');
      if (r.available) {
        gpuRes.className = 'result ok';
        gpuRes.textContent = `✓ ${r.name} (driver ${r.driver}, CUDA ${r.cuda || '?'})`;
        set('TRANSCRIPTION_DEVICE', 'cuda');
        set('__torchIndex', r.recommendedTorch || 'cu121');
      } else {
        gpuRes.className = 'result err';
        gpuRes.textContent = '✗ ' + (r.reason || 'No NVIDIA GPU detected — use CPU');
        set('TRANSCRIPTION_DEVICE', 'cpu');
      }
    });

    // Install button + live log
    const installRow = el('div', { class: 'test-row', style: 'margin-top:12px' });
    const installBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, '⬇️ Install PyTorch + faster-whisper');
    const installState = el('span', { class: 'result' });
    installRow.appendChild(installBtn); installRow.appendChild(installState);
    box.appendChild(installRow);
    const logPre = el('pre', { class: 'install-log', style: 'display:none' });
    box.appendChild(logPre);

    let poller = null;
    const poll = () => api('/api/setup/install-python/status').then((s) => {
      logPre.style.display = 'block';
      logPre.textContent = s.log || '';
      logPre.scrollTop = logPre.scrollHeight;
      installState.className = 'result pending';
      installState.textContent = s.step ? `… ${s.step}` : 'Installing…';
      if (s.done) {
        clearInterval(poller); poller = null;
        installBtn.disabled = false;
        if (s.ok) { installState.className = 'result ok'; installState.textContent = '✓ Installed! Local transcription is ready.'; }
        else { installState.className = 'result err'; installState.textContent = '✗ ' + (s.error || 'Install failed — see log'); }
      }
    });

    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      installState.className = 'result pending';
      installState.textContent = 'Starting…';
      const r = await api('/api/setup/install-python', {
        method: 'POST',
        body: JSON.stringify({ device: get('TRANSCRIPTION_DEVICE', 'cpu'), basePython: get('__basePython'), torchIndex: get('__torchIndex') }),
      });
      if (!r.ok) { installState.className = 'result err'; installState.textContent = '✗ ' + (r.error || 'Could not start'); installBtn.disabled = false; return; }
      if (r.venvPython) set('PYTHON_COMMAND', r.venvPython);
      poller = setInterval(poll, 2000); poll();
    });
  }

  // ---- Ollama model picker -----------------------------------------------
  function renderOllamaModelPicker(c) {
    const field = el('div', { class: 'field' });
    field.appendChild(el('label', {}, 'Model'));
    const wrap = el('div', { class: 'test-row' });
    const sel = el('select', { style: 'flex:1' });
    const cur = get('OLLAMA_MODEL', 'llama3.1:8b');
    sel.appendChild(el('option', { value: cur }, cur + ' (current)'));
    sel.addEventListener('change', () => set('OLLAMA_MODEL', sel.value));
    const loadBtn = el('button', { class: 'btn btn-sm', type: 'button' }, '↻ Load models');
    const res = el('span', { class: 'result' });
    wrap.appendChild(sel); wrap.appendChild(loadBtn);
    field.appendChild(wrap);
    field.appendChild(res);
    c.appendChild(field);

    loadBtn.addEventListener('click', async () => {
      res.className = 'result pending'; res.textContent = 'Loading…';
      const r = await api('/api/setup/test/ollama', { method: 'POST', body: JSON.stringify({ url: get('OLLAMA_URL') }) });
      if (r.ok && r.models && r.models.length) {
        sel.innerHTML = '';
        r.models.forEach((m) => sel.appendChild(el('option', { value: m }, m)));
        if (r.models.includes(cur)) sel.value = cur; else set('OLLAMA_MODEL', sel.value);
        res.className = 'result ok'; res.textContent = `✓ ${r.models.length} models loaded`;
      } else if (r.ok) {
        res.className = 'result err'; res.textContent = '✗ Connected, but no models. Run: ollama pull llama3.1:8b';
      } else {
        res.className = 'result err'; res.textContent = '✗ ' + (r.error || 'Could not reach Ollama');
      }
    });
  }

  // ---- Navigation ---------------------------------------------------------
  function buildNav() {
    const nav = $('#step-nav');
    nav.innerHTML = '';
    steps.forEach((s, i) => {
      const li = el('li', { class: i === current ? 'active' : (i < current ? 'done' : '') });
      li.appendChild(el('span', { class: 'dot' }, (i < current && !SETTINGS_MODE) ? '✓' : String(i + 1)));
      li.appendChild(el('span', {}, s.title));
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => { if (SETTINGS_MODE || i <= current) { current = i; renderStep(); } });
      nav.appendChild(li);
    });
  }

  function renderStep() {
    const c = $('#step-container');
    c.innerHTML = '';
    const wrap = el('div', { class: 'step' });
    c.appendChild(wrap);
    steps[current].render(wrap);
    buildNav();
    if (SETTINGS_MODE) {
      $('#btn-back').style.visibility = 'hidden';
      $('#btn-next').textContent = 'Save Changes';
    } else {
      $('#btn-back').style.visibility = current === 0 ? 'hidden' : 'visible';
      $('#btn-next').textContent = current === steps.length - 1 ? 'Finish Setup' : 'Next';
    }
    c.scrollTop = 0;
  }

  async function saveProgress() {
    const payload = {};
    Object.keys(state).forEach((k) => { if (!k.startsWith('__')) payload[k] = state[k]; });
    $('#save-indicator').textContent = 'Saving…';
    try {
      await api('/api/setup/save', { method: 'POST', body: JSON.stringify(payload) });
      $('#save-indicator').textContent = 'Saved';
      setTimeout(() => ($('#save-indicator').textContent = ''), 1500);
    } catch (e) {
      $('#save-indicator').textContent = 'Save failed';
    }
  }

  // Build the map URL the full app will serve on (its WEBSERVER_PORT), which is
  // usually different from the setup server's port.
  function computeMapUrl() {
    const port = String(get('WEBSERVER_PORT', '80')).trim() || '80';
    const proto = location.protocol; // 'http:' | 'https:'
    const host = location.hostname;
    const isDefault = (proto === 'http:' && port === '80') || (proto === 'https:' && port === '443');
    return `${proto}//${host}${isDefault ? '' : ':' + port}/`;
  }

  // One-click relaunch: ask the setup server to exit-and-restart (via the
  // start.bat/start.sh loop), then poll the map until it's up and redirect.
  async function launchApp(container) {
    const mapUrl = computeMapUrl();
    container.innerHTML = '';
    const s = el('div', { class: 'success-screen' });
    s.appendChild(el('div', { class: 'big' }, '🚀'));
    s.appendChild(el('h1', {}, 'Starting Scanner Map…'));
    const msg = el('p', { class: 'lead' }, 'Applying your settings and starting the app. This can take 10–30 seconds (longer on first run while models/Discord load).');
    s.appendChild(msg);
    const link = el('p', { class: 'hint' }, '');
    link.appendChild(document.createTextNode('If this page does not redirect automatically, open '));
    link.appendChild(el('a', { href: mapUrl }, mapUrl));
    s.appendChild(link);
    container.appendChild(s);

    await api('/api/setup/launch', { method: 'POST', body: '{}' }).catch(() => {});

    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        // no-cors resolves (opaque) once the map server responds; rejects while down.
        await fetch(mapUrl, { mode: 'no-cors', cache: 'no-store' });
        msg.textContent = 'Scanner Map is up! Redirecting…';
        location.href = mapUrl;
      } catch (_) {
        if (tries > 80) { msg.textContent = 'Still starting… open the link below once it finishes.'; return; }
        setTimeout(tick, 1500);
      }
    };
    // Give the process time to exit + relaunch + bind the port before polling.
    setTimeout(tick, 3500);
  }

  async function finish() {
    const payload = {};
    Object.keys(state).forEach((k) => { if (!k.startsWith('__')) payload[k] = state[k]; });
    const r = await api('/api/setup/finish', { method: 'POST', body: JSON.stringify(payload) });
    const c = $('#step-container');
    c.innerHTML = '';
    const s = el('div', { class: 'success-screen' });
    if (r.ok) {
      s.appendChild(el('div', { class: 'big' }, '🎉'));
      s.appendChild(el('h1', {}, 'Setup Complete!'));
      if (r.apiKey) s.appendChild(renderApiKeyCard(r.apiKey));
      if (get('__launcher')) {
        // Launched via start.bat/start.sh → we can start the full app for them.
        s.appendChild(el('p', { class: 'lead' }, 'Click below and Scanner Map will start automatically, then take you to the map. Point SDRTrunk / TrunkRecorder / rdio-scanner at your upload port using the API key above.'));
        const btn = el('button', { class: 'btn btn-primary', type: 'button', style: 'margin-top:16px' }, '🚀 Start Scanner Map');
        btn.addEventListener('click', () => launchApp(c));
        s.appendChild(btn);
      } else {
        s.appendChild(el('p', { class: 'lead' }, 'Restart Scanner Map to apply everything, then point SDRTrunk / TrunkRecorder / rdio-scanner at your upload port.'));
        s.appendChild(infoBox('Tip: next time, start with <b>start.bat</b> (Windows) or <b>./start.sh</b> (Linux/macOS) — then this last step becomes a one-click “Start Scanner Map” button.'));
        s.appendChild(el('a', { class: 'btn btn-primary', href: computeMapUrl(), style: 'margin-top:16px' }, 'Open the Map (after restart)'));
      }
    } else {
      s.appendChild(el('div', { class: 'big' }, '⚠️'));
      s.appendChild(el('h1', {}, 'Could not finish'));
      s.appendChild(el('p', { class: 'lead' }, r.error || 'Unknown error'));
    }
    c.appendChild(s);
    $('.wizard-actions').style.display = 'none';
  }

  function renderApiKeyCard(key) {
    const card = el('div', { class: 'apikey-card' });
    card.appendChild(el('div', { class: 'apikey-title' }, '🔑 Your upload API key'));
    card.appendChild(el('div', { class: 'apikey-desc' },
      'Paste this into the <b>API key</b> field of SDRTrunk / TrunkRecorder / rdio-scanner so they can upload calls. ' +
      'Keep it secret. You can view or regenerate it any time from the in-app Settings page.'));
    const row = el('div', { class: 'apikey-row' });
    const input = el('input', { type: 'text', readonly: 'readonly', value: key });
    const copy = el('button', { class: 'btn btn-sm', type: 'button' }, 'Copy');
    copy.addEventListener('click', () => { input.select(); navigator.clipboard?.writeText(key); toast('API key copied', 'ok'); });
    row.appendChild(input); row.appendChild(copy);
    card.appendChild(row);
    return card;
  }

  $('#btn-next').addEventListener('click', async () => {
    await saveProgress();
    if (SETTINGS_MODE) { toast('Settings saved. Some changes need a restart.', 'ok'); return; }
    if (current === steps.length - 1) { finish(); return; }
    current += 1;
    renderStep();
  });
  $('#btn-back').addEventListener('click', () => { if (current > 0) { current -= 1; renderStep(); } });

  // Grab an admin session token if one exists (needed when auth is enabled),
  // then load existing config and start.
  async function boot() {
    try {
      const sess = await fetch('/api/sessions/current').then((r) => r.json()).catch(() => null);
      if (sess && sess.session && sess.session.token) authToken = sess.session.token;
    } catch (_) { /* no session / auth disabled */ }
    try {
      const status = await api('/api/setup/status');
      Object.assign(state, status.config || {});
      Object.entries(status.secretsSet || {}).forEach(([k, v]) => { state['__secretSet_' + k] = v; });
      state['__launcher'] = !!status.launcher;
    } catch (_) { /* ignore */ }
    // Deep-link support: /settings#sessions jumps straight to that tab.
    if (SETTINGS_MODE && location.hash) {
      const slug = location.hash.slice(1).toLowerCase();
      const idx = steps.findIndex((s) => s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') === slug);
      if (idx >= 0) current = idx;
    }
    renderStep();
  }
  window.addEventListener('hashchange', () => {
    if (!SETTINGS_MODE) return;
    const slug = location.hash.slice(1).toLowerCase();
    const idx = steps.findIndex((s) => s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') === slug);
    if (idx >= 0) { current = idx; renderStep(); }
  });
  boot();
})();
