// geocoding.js - Address extraction and geocoding module (using LocationIQ)

require('dotenv').config();
const fetch = require('node-fetch');
const winston = require('winston');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');

// Environment variables - strict loading from .env only
const {
  LOCATIONIQ_API_KEY = null,
  GOOGLE_MAPS_API_KEY = null, // Added for Google API support
  GEOCODING_STATE,
  GEOCODING_COUNTRY,
  GEOCODING_TARGET_COUNTIES,
  GEOCODING_CITY, // Still used as a fallback town name in LLM prompt
  TIMEZONE,
  // --- NEW: AI Provider Env Vars ---
  AI_PROVIDER,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  OLLAMA_URL,
  OLLAMA_MODEL,
  TARGET_CITIES_LIST // Kept for potential future use or reference
} = process.env;

// --- VALIDATE AI-RELATED ENV VARS ---
if (!AI_PROVIDER) {
    console.error("FATAL: [Geocoding] AI_PROVIDER is not set in the .env file. Please specify 'ollama' or 'openai'.");
    process.exit(1);
}

if (AI_PROVIDER.toLowerCase() === 'openai') {
    if (!OPENAI_API_KEY || !OPENAI_MODEL) {
        console.error("FATAL: [Geocoding] AI_PROVIDER is 'openai', but OPENAI_API_KEY or OPENAI_MODEL is missing in the .env file.");
        process.exit(1);
    }
} else if (AI_PROVIDER.toLowerCase() === 'ollama') {
    if (!OLLAMA_URL || !OLLAMA_MODEL) {
        console.error("FATAL: [Geocoding] AI_PROVIDER is 'ollama', but OLLAMA_URL or OLLAMA_MODEL is missing in the .env file.");
        process.exit(1);
    }
} else {
    console.error(`FATAL: [Geocoding] Invalid AI_PROVIDER specified in .env file: '${AI_PROVIDER}'. Must be 'openai' or 'ollama'.`);
    process.exit(1);
}
// --- END VALIDATION ---

// Validate required environment variables
// Check if we have at least one geocoding API key
const hasGoogleMaps = !!GOOGLE_MAPS_API_KEY;
const hasLocationIQ = !!LOCATIONIQ_API_KEY;

if (!hasGoogleMaps && !hasLocationIQ) {
  console.error('ERROR: At least one geocoding API key is required (GOOGLE_MAPS_API_KEY or LOCATIONIQ_API_KEY)');
  process.exit(1);
}

// Determine which provider to use and validate required variables
let geocodingProvider = null;

if (hasGoogleMaps && hasLocationIQ) {
  // Both available - prefer LocationIQ for consistency with existing setup
  geocodingProvider = 'locationiq';
  console.log('[Geocoding] Both Google Maps and LocationIQ available, using LocationIQ');
} else if (hasLocationIQ) {
  geocodingProvider = 'locationiq';
  console.log('[Geocoding] Using LocationIQ for geocoding');
} else if (hasGoogleMaps) {
  geocodingProvider = 'google';
  console.log('[Geocoding] Using Google Maps for geocoding');
}

// Validate required environment variables based on provider
const requiredVars = ['GEOCODING_STATE', 'GEOCODING_COUNTRY', 'GEOCODING_CITY', 'GEOCODING_TARGET_COUNTIES'];
const missingVars = requiredVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Set default values for any missing optional variables
if (!process.env.GEOCODING_STATE) process.env.GEOCODING_STATE = 'MD';
if (!process.env.GEOCODING_COUNTRY) process.env.GEOCODING_COUNTRY = 'us';
if (!process.env.GEOCODING_CITY) process.env.GEOCODING_CITY = 'Baltimore';
if (!process.env.GEOCODING_TARGET_COUNTIES) process.env.GEOCODING_TARGET_COUNTIES = 'Baltimore,Baltimore City,Anne Arundel,Howard,Carroll,Harford';

// Parse target counties into array
const TARGET_COUNTIES = process.env.GEOCODING_TARGET_COUNTIES.split(',').map(county => county.trim());
const COUNTRY_CODES = process.env.GEOCODING_COUNTRY; // LocationIQ uses country codes

// Logger setup (remains the same)
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => moment().tz(TIMEZONE).format('MM/DD/YYYY HH:mm:ss.SSS')
    }),
    winston.format.printf(({ timestamp, level, message }) => {
      if (message.includes('Talk Group') ||
          message.includes('Incoming Request')) {
        return `${timestamp} \x1b[33m[${level.toUpperCase()}] ${message}\x1b[0m`;
      }
      if (message.includes('Extracted Address') ||
          message.includes('Geocoded Address')) {
        return `${timestamp} \x1b[32m[${level.toUpperCase()}] ${message}\x1b[0m`;
      }
      if (level === 'info') {
        return `${timestamp} \x1b[37m[${level.toUpperCase()}] ${message}\x1b[0m`;
      }
      const colors = { error: '\x1b[31m', warn: '\x1b[33m', debug: '\x1b[36m' };
      const color = colors[level] || '\x1b[37m';
      return `${timestamp} ${color}[${level.toUpperCase()}] ${message}\x1b[0m`;
    })
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console()
  ]
});

// Override logger.info (remains the same)
const originalInfo = logger.info.bind(logger);
const allowedPatterns = [
  /^Geocoded Address: ".+" with coordinates \(.+, .+\) in .+$/,
  /^LLM Extracted Address:/
];
logger.info = function (...args) {
  const message = args.join(' ');

  // Specific check to exclude "No address found" messages for LLM extractions
  if (message.startsWith('LLM Extracted Address:') && 
      (message.endsWith('"No address found"') || message.endsWith('"No address found."'))) {
    return; // Do not log this specific message
  }

  const shouldLog = allowedPatterns.some((pattern) => pattern.test(message));
  if (shouldLog) {
    originalInfo(...args);
  }
};

// Build TALK_GROUPS from environment variables (remains the same)
const TALK_GROUPS = {};
Object.keys(process.env).forEach(key => {
  if (key.startsWith('TALK_GROUP_')) {
    const talkGroupId = key.replace('TALK_GROUP_', '');
    TALK_GROUPS[talkGroupId] = process.env[key];
  }
});
logger.info(`Loaded ${Object.keys(TALK_GROUPS).length} talk groups from environment variables`);

// Target cities that are allowed to plot. If non-empty, an address whose city
// is NOT in this list is rejected (it won't appear on the map).
const TARGET_CITIES = process.env.TARGET_CITIES_LIST
  ? process.env.TARGET_CITIES_LIST.split(',').map(city => city.trim()).filter(Boolean)
  : [];

// --- Normalization helpers so matching is forgiving (case + suffixes) ---
function normalizeCounty(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(county|parish|borough)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function normalizePlace(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(city|town|township|village)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const TARGET_COUNTY_SET = new Set(TARGET_COUNTIES.map(normalizeCounty).filter(Boolean));
const TARGET_CITY_SET = new Set(TARGET_CITIES.map(normalizePlace).filter(Boolean));

function isTargetCounty(county) {
  if (!TARGET_COUNTY_SET.size) return true; // no counties configured -> allow
  return TARGET_COUNTY_SET.has(normalizeCounty(county));
}
function isTargetCity(city) {
  if (!TARGET_CITY_SET.size) return true; // empty list -> allow all (county still gates)
  if (!city) return false;
  return TARGET_CITY_SET.has(normalizePlace(city));
}

/**
 * Per-talkgroup metadata, primarily populated from the imported `talk_groups`
 * SQLite table (the same data the Setup Wizard imports). Maps talkgroup id ->
 * { town, county }. This replaces the old, rarely-used TALK_GROUP_<id> env vars
 * and gives the LLM/geocoder accurate per-channel county context.
 */
const TALK_GROUP_META = {};

/**
 * Load talkgroup metadata. Prefers the DB `talk_groups` table; falls back to
 * (and merges with) any legacy TALK_GROUP_<id> environment variables.
 * @param {import('sqlite3').Database} [db]
 */
function loadTalkGroups(db) {
  // Seed from legacy env vars first (so DB can override with richer data).
  Object.keys(TALK_GROUPS).forEach((id) => {
    TALK_GROUP_META[id] = { town: TALK_GROUPS[id], county: null };
  });

  if (!db || typeof db.all !== 'function') {
    logger.info(`Loaded ${Object.keys(TALK_GROUP_META).length} talk groups (env only; no DB handle)`);
    return Promise.resolve(TALK_GROUP_META);
  }

  return new Promise((resolve) => {
    db.all('SELECT id, system, alpha_tag, county FROM talk_groups', (err, rows) => {
      if (err) {
        logger.warn(`Could not load talk_groups from DB: ${err.message}. Using env vars only.`);
        return resolve(TALK_GROUP_META);
      }
      (rows || []).forEach((row) => {
        const id = String(row.id);
        const sys = String(row.system || '').trim().toLowerCase();
        const meta = {
          town: (TALK_GROUPS[id] || row.alpha_tag || '').trim(),
          county: (row.county || '').trim() || null,
        };
        // Store under a system-scoped key so overlapping ids across systems keep
        // their own county hint, plus a plain-id key as a best-effort fallback
        // for callers that don't know the system.
        if (sys) TALK_GROUP_META[`${sys}:${id}`] = meta;
        if (!TALK_GROUP_META[id] || sys === '') TALK_GROUP_META[id] = meta;
      });
      logger.info(`Loaded ${Object.keys(TALK_GROUP_META).length} talk group entries (DB + env) for geocoding context`);
      resolve(TALK_GROUP_META);
    });
  });
}

/**
 * Helper Functions
 */

/**
 * Escapes special characters in a string for use in a regular expression. (remains the same)
 * @param {string} string - The string to escape.
 * @returns {string} - The escaped string.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Street-type tokens — used for format checks and transcript anchoring. */
const STREET_SUFFIX_WORDS = new Set([
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane',
  'blvd', 'boulevard', 'pkwy', 'parkway', 'hwy', 'highway', 'way', 'circle',
  'cir', 'court', 'ct', 'place', 'pl', 'terrace', 'trl', 'trail', 'loop',
  'run', 'row', 'crossing', 'xing', 'square', 'sq', 'block',
]);
const STREET_SUFFIX_RE = /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|pkwy|parkway|hwy|highway|way|circle|cir|court|ct|place|pl|terrace|trl|trail|loop|run|row|square|sq)\b/i;

/**
 * Strip trailing city/state from a normalized address for structural checks.
 */
function addressCorePart(address) {
  let core = String(address || '').trim();
  core = core.replace(new RegExp(`,\\s*${escapeRegExp(GEOCODING_STATE)}\\s*$`, 'i'), '').trim();
  core = core.replace(new RegExp(`,\\s*${escapeRegExp(GEOCODING_CITY)}\\s*$`, 'i'), '').trim();
  // Drop any other trailing ", City" segments the model may have added.
  const parts = core.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) core = parts[0];
  return core.trim();
}

/**
 * Reject LLM output that is only numbers, timing references, or lacks a real street/place.
 */
function looksLikePlausibleAddress(address) {
  const core = addressCorePart(address);
  if (!core) return false;

  // Bare numbers: "723", "723. 622", "723, 622"
  if (/^\d{1,6}([.\s,]+\d{1,6})*$/.test(core)) return false;

  // Intersections are valid even without a house number.
  if (/\s&\s/.test(core) || /\band\b/i.test(core)) return true;

  // House number + street suffix (e.g. "723 Main St", "300 Maple Dr")
  if (/^\d{1,6}\s+.+/i.test(core) && STREET_SUFFIX_RE.test(core)) return true;

  // Named place / POI with multiple words and no leading bare number.
  const words = core.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && !/^\d{1,6}$/.test(words[0])) return true;

  // House number + alphabetic street name without suffix ("7908 Cindy Lane" before normalization)
  if (/^\d{1,6}\s+[a-z]{2,}/i.test(core)) {
    const afterNum = words.slice(1);
    if (afterNum.some((w) => /^[a-z]{3,}$/i.test(w) && !STREET_SUFFIX_WORDS.has(w.toLowerCase()))) {
      return true;
    }
  }

  return false;
}

/**
 * Anti-hallucination: at least one significant place/street word in the LLM output
 * must appear in the original transcript (prevents inventing "Main St" for "723").
 */
function addressAnchoredInTranscript(address, transcript) {
  const core = addressCorePart(address).toLowerCase();
  const transcriptLower = String(transcript || '').toLowerCase();
  if (!core || !transcriptLower) return false;

  const tokens = core.split(/[^a-z0-9]+/i).filter((t) => t.length >= 3);
  const placeWords = tokens.filter((t) => !STREET_SUFFIX_WORDS.has(t) && !/^\d+$/.test(t));

  if (placeWords.length === 0) return false;

  const matched = placeWords.filter((w) => transcriptLower.includes(w));
  if (matched.length === 0) return false;

  // Intersections: need evidence of two different street names in the transcript.
  if (/\s&\s/.test(core) || /\band\b/.test(core)) {
    const sides = core.split(/\s+(?:&|and)\s+/i);
    if (sides.length >= 2) {
      const sideHits = sides.map((side) => {
        const sideWords = side.split(/[^a-z0-9]+/i)
          .filter((t) => t.length >= 3 && !STREET_SUFFIX_WORDS.has(t) && !/^\d+$/.test(t));
        return sideWords.some((w) => transcriptLower.includes(w));
      });
      return sideHits.filter(Boolean).length >= 2;
    }
  }

  return true;
}

/**
 * Low-level LLM call shared by extraction and verification. Returns trimmed text
 * (with any <think> block stripped) or null on error/timeout. Honors AI_PROVIDER.
 * @param {string} prompt
 * @param {{maxTokens?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<string|null>}
 */
async function callLLM(prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 800;
  const timeoutMs = opts.timeoutMs || (parseInt(process.env.AI_EXTRACT_TIMEOUT_MS, 10) || 30000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    logger.warn(`[Geocoding] AI request timed out after ${timeoutMs / 1000}s.`);
    controller.abort();
  }, timeoutMs);
  try {
    let text = '';
    if (AI_PROVIDER.toLowerCase() === 'openai') {
      if (!OPENAI_API_KEY) {
        logger.error('[Geocoding] AI_PROVIDER is openai but OPENAI_API_KEY is not configured!');
        return null;
      }
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI API error! status: ${response.status}. Body: ${errorBody}`);
      }
      const result = await response.json();
      if (result.choices && result.choices.length > 0 && result.choices[0].message) {
        text = result.choices[0].message.content.trim();
      }
    } else {
      const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt,
          stream: false,
          think: false,
          options: { temperature: 0, top_p: 0.1, num_predict: maxTokens },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama API error! status: ${response.status}`);
      const result = await response.json();
      text = (result.response || '').trim();
    }

    // Strip reasoning-model <think> blocks (closed or truncated/open).
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
    const openThink = text.search(/<think>/i);
    if (openThink >= 0) text = text.slice(0, openThink).trim();
    return text;
  } catch (error) {
    if (error.name === 'AbortError') {
      logger.error(`[Geocoding] AI request timed out: ${error.message}`);
    } else {
      logger.error(`[Geocoding] AI request failed: ${error.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Second-pass sanity check: ask the LLM whether the extracted address is really the
 * incident location described in the transcript. Defaults ON; disable with
 * AI_VERIFY_ADDRESS=false. On error/timeout it fails OPEN (keeps the address) so a
 * flaky AI never silently drops every plot.
 * @param {string} address - The normalized address we're about to geocode.
 * @param {string} transcript - The original transcript.
 * @returns {Promise<boolean>} - true if the address should be kept.
 */
async function verifyAddressWithLLM(address, transcript) {
  if (String(process.env.AI_VERIFY_ADDRESS || 'true').toLowerCase() === 'false') return true;

  // Verify only the street/place part. The trailing city/state was likely
  // auto-added to complete the address and usually isn't spoken in the
  // transcript, so including it would cause false rejections.
  const core = addressCorePart(address) || address;

  const prompt = `You are checking whether a street/place was correctly extracted from a first-responder dispatch transcript.

TRANSCRIPT:
"${transcript}"

EXTRACTED STREET/PLACE:
"${core}"

A city and state may have been added automatically to complete the address — IGNORE the city/state and judge only the street, intersection, or named place above.
Answer NO if any of these are true:
- The street/place name does NOT appear in the transcript (it was invented or hallucinated).
- It is actually a unit number, radio code, ETA/time, signal report, patient age, callsign, or other number — not a real location.
- The transcript contains no real street, intersection, or named place at all.
Answer YES if the transcript mentions this street, intersection, or named place (even loosely) as a location.

Respond with exactly one word: YES or NO.`;

  const answer = await callLLM(prompt, { maxTokens: 200 });
  if (answer === null) {
    logger.warn(`[Geocoding] Address verification unavailable (AI error/timeout); keeping "${address}".`);
    return true; // fail open
  }
  const verdict = answer.toUpperCase();
  const isYes = /\bYES\b/.test(verdict) && !/\bNO\b/.test(verdict);
  if (!isYes) {
    logger.info(`[Geocoding] Verification rejected "${address}" for transcript snippet: "${String(transcript).slice(0, 120)}" (LLM said: "${answer.slice(0, 40)}")`);
  } else {
    logger.info(`[Geocoding] Verification passed for "${address}".`);
  }
  return isYes;
}

/**
 * Uses local LLM to extract and complete addresses from the full transcript. (remains the same)
 * @param {string} transcript - The full transcript text.
 * @param {string} town - The town associated with the transcript.
 * @returns {Promise<string|null>} - The extracted and completed address or null if not found.
 */
async function extractAddressWithLLM(transcript, town) {
  try {
    const countiesString = TARGET_COUNTIES.join(', ');
    const commonPrompt = `You extract the incident LOCATION from a first-responder dispatch transcript.
The transcript mixes radio codes, unit numbers, call types, and chatter together with the address — ignore the codes and find the location of the incident.

What counts as a location: a street with a house number, an intersection of two streets, or a specific named place (mall, park, school, hospital, building).
What does NOT count: bare numbers, unit IDs (e.g. "ALS-742", "Engine 7"), call types, ETA/timing phrases, signal-strength numbers, or radio chatter with no street/place name.

Rules:
- Normalize spelled-out or hyphenated house numbers ("7-9-0-8 Cindy Lane" -> "7908 Cindy Lane").
- If a house number is present, output ONLY that one street (e.g. "7908 Cindy Lane"). Do NOT append the cross street.
- "Cross street X", "cross of X", or a second street listed after the main one is just a nearby reference — IGNORE it and keep only the street that has the house number.
- Use the "&" intersection format ONLY when there is NO house number and the location is genuinely described as the corner of two streets.
- Never invent a street that is not spoken in the transcript. Every street/place word in your answer MUST appear in the transcript.
- Only add ", ${GEOCODING_CITY}, ${GEOCODING_STATE}" to complete an address that has a street but no city. Never output the city/state alone.
- Coverage counties: ${countiesString}.
${TARGET_CITIES.length ? `- Known cities/towns: ${TARGET_CITIES.join(', ')}. Prefer a city actually named in the transcript; otherwise pick the most likely one from this list.` : ''}

Examples that are NOT locations (respond: No address found):
- "I made time for 723. 622." (timing/ETA numbers, no street)
- "Copy that, unit 5 responding, 10-4 received"
- "Reference 7-9-0-8" (digits alone, no street name follows)
- "723" or "723, ${GEOCODING_CITY}" (number without a street or place name)

Formatting:
- Full address: 123 Main St, ${GEOCODING_CITY}, ${GEOCODING_STATE}
- Block ("300 block of Maple Dr") -> 300 Maple Dr, ${GEOCODING_CITY}, ${GEOCODING_STATE}
- Intersection (no house number only): use "&" between the two streets -> Main St & Oak Ave, ${GEOCODING_CITY}, ${GEOCODING_STATE}
- Address WITH a house number plus a cross street -> keep only the numbered street. ("71003 Luttrell Lane, cross street Westchester Drive" -> 71003 Luttrell Lane, ${GEOCODING_CITY}, ${GEOCODING_STATE})

Respond with ONLY the location on one line (for example: 7908 Cindy Lane, ${GEOCODING_CITY}, ${GEOCODING_STATE}), or exactly: No address found
Do not wrap the answer in quotes and do not add any commentary.

Transcript (from ${town}):
"${transcript}"`;

    // Add AbortController for timeout
    const controller = new AbortController();
    const AI_TIMEOUT_MS = parseInt(process.env.AI_EXTRACT_TIMEOUT_MS, 10) || 30000;
    const timeoutId = setTimeout(() => {
        logger.warn(`[Geocoding] AI request timed out after ${AI_TIMEOUT_MS / 1000}s for address extraction.`);
        controller.abort();
    }, AI_TIMEOUT_MS);

    let extractedAddress = '';

    if (AI_PROVIDER.toLowerCase() === 'openai') {
        if (!OPENAI_API_KEY) {
            logger.error("[Geocoding] FATAL: AI_PROVIDER is set to openai, but OPENAI_API_KEY is not configured!");
            return null;
        }
        logger.info(`[Geocoding] Extracting address with OpenAI model: ${OPENAI_MODEL}`);

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [{ role: 'user', content: commonPrompt }],
                temperature: 0.1, // Very low temp for extraction
                max_tokens: 50
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`OpenAI API error! status: ${response.status}. Body: ${errorBody}`);
        }
        const result = await response.json();
        if (result.choices && result.choices.length > 0 && result.choices[0].message) {
            extractedAddress = result.choices[0].message.content.trim();
        }

    } else { // Default to Ollama
        logger.info(`[Geocoding] Extracting address with Ollama model: ${OLLAMA_MODEL}`);

        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: commonPrompt,
            stream: false,
            // Disable chain-of-thought for reasoning models (qwen3, deepseek-r1, …).
            // Address extraction is a simple task; thinking just adds 8-15s/call
            // (which blows the timeout) and is no more accurate. Unknown to older
            // Ollama builds, which harmlessly ignore the field.
            think: false,
            // Deterministic, low-creativity decoding for reliable extraction.
            // Without this, Ollama uses the model default (~0.8) and the same
            // transcript intermittently yields "No address found".
            options: { temperature: 0, top_p: 0.1, num_predict: 800 }
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`Ollama API error! status: ${response.status}`);
        }

        const result = await response.json();
        extractedAddress = result.response.trim();
    }
    
    clearTimeout(timeoutId);

    // --- ADDED: Remove <think> block (reasoning models: qwen3, deepseek-r1, …) ---
    // Some Ollama builds also return reasoning in a separate "thinking" field and
    // leave only the answer in "response"; in that case there's nothing to strip.
    const thinkBlockRegex = /<think>[\s\S]*?<\/think>\s*/gi;
    extractedAddress = extractedAddress.replace(thinkBlockRegex, '').trim();
    // If a think block was truncated (open tag, no close), drop everything after it.
    const openThink = extractedAddress.search(/<think>/i);
    if (openThink >= 0) extractedAddress = extractedAddress.slice(0, openThink).trim();
    // --- END ADDED ---

    // Strip surrounding quotes the model sometimes adds (e.g. "7908 Cindy Lane, ...")
    // and collapse to a single line; otherwise the literal quotes break geocoding.
    extractedAddress = extractedAddress.split('\n')[0].trim();
    extractedAddress = extractedAddress.replace(/^["'`]+|["'`]+$/g, '').trim();

    logger.info(`LLM Extracted Address: \"${extractedAddress}\"`);

    if (/^no address found\.?$/i.test(extractedAddress)) {
      return null;
    }

    // --- ADDED: Check for overly generic LLM response ---
    const trimmedLlmOutput = extractedAddress.trim();
    const genericCityStatePattern = new RegExp(`^${escapeRegExp(GEOCODING_CITY)},\\s*${escapeRegExp(GEOCODING_STATE)}$`, 'i');
    const justCityPattern = new RegExp(`^${escapeRegExp(GEOCODING_CITY)}$`, 'i');

    if (genericCityStatePattern.test(trimmedLlmOutput) || justCityPattern.test(trimmedLlmOutput)) {
      logger.info(`LLM returned a generic city/state or just city: "${trimmedLlmOutput}". Treating as no address found.`);
      return null;
    }
    // --- END ADDED ---

    return extractedAddress;
  } catch (error) {
    // Check specifically for AbortError (timeout)
    if (error.name === 'AbortError') {
         logger.error(`[Geocoding] AI request timed out during address extraction: ${error.message}`);
         return null; // Return null on timeout
    }
    logger.error(`Error extracting address with LLM: ${error.message}`);
    return null;
  }
}

/**
 * Geocodes an address using LocationIQ's Geocoding API, filtering for specific results.
 * @param {string} address - The address query string.
 * @returns {Promise<{ lat: number, lng: number, formatted_address: string, county: string } | null>} - Geocoded data or null.
 */
async function geocodeAddress(address) {
  // 1. Input Validation
  if (!address || address.trim() === '') {
    logger.info('No address provided for geocoding.');
    return null;
  }

  // Check which geocoding provider to use
  if (geocodingProvider === 'locationiq') {
    return await geocodeAddressWithLocationIQ(address);
  } else if (geocodingProvider === 'google') {
    return await geocodeAddressWithGoogleMaps(address);
  } else {
    logger.error('No geocoding API key available');
    return null;
  }
}

async function geocodeAddressWithLocationIQ(address) {
  // 2. Prepare API Request
  const endpoint = `https://us1.locationiq.com/v1/search`;
  const params = new URLSearchParams({
    q: address,
    key: LOCATIONIQ_API_KEY,
    format: 'json',
    addressdetails: '1',
    normalizeaddress: '1',
    countrycodes: COUNTRY_CODES,
    limit: '1'
  });

  try {
    // 3. Make API Call
    const response = await fetch(`${endpoint}?${params.toString()}`);
    if (!response.ok) {
      logger.error(`LocationIQ API error: ${response.status} ${response.statusText}`);
      const errorBody = await response.text();
      logger.error(`LocationIQ Error Body: ${errorBody} for query: "${address}"`);
      return null;
    }

    // 4. Parse Response
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn(`LocationIQ API returned no results for address: "${address}"`);
      return null;
    }

    const result = data[0];

    // Extract key fields
    const lat = parseFloat(result.lat);
    const lon = parseFloat(result.lon);
    const display_name = result.display_name;
    const resultType = result.type;
    const resultClass = result.class;
    const addressDetails = result.address || {};
    const county = addressDetails.county || null;

    // Basic check for essential coordinates and display name
    if (isNaN(lat) || isNaN(lon) || !display_name) {
       logger.warn(`LocationIQ response missing essential fields (lat/lon/display_name) for address: "${address}"`);
       return null;
    }

    // --- START: Final Revised Filtering Logic ---

    // 5. Specificity Filtering - Require road info unless it's a specific non-admin place/highway.
    const hasRoadInfo = !!(addressDetails.road);
    const isCityAdminType = ['city', 'town', 'village', 'municipality', 'administrative', 'county', 'state', 'postcode'].includes(resultType);

    // Is it a highway/intersection? (Specific enough)
    const isHighwayOrIntersection = (resultClass === 'highway' || resultType === 'intersection');

    // Is it classified as a 'place' BUT NOT also typed as a city/admin area? (Specific enough POI)
    const isSpecificPlace = (resultClass === 'place' && !isCityAdminType);

    // If there is NO road information AND it's NOT a specific place AND it's NOT a highway/intersection, filter it out.
    if (!hasRoadInfo && !isSpecificPlace && !isHighwayOrIntersection) {
        logger.info(`[Filter Action] Skipping result lacking road info and not a specific place/highway (Type: ${resultType}, Class: ${resultClass}): "${display_name}"`);
        return null;
    }

    // --- END: Final Revised Filtering Logic ---


    // 6. Target County Filtering (normalized: case-insensitive, ignores the
    //    "County"/"Parish" suffix so "Montgomery" matches "Montgomery County").
    if (!county || !isTargetCounty(county)) {
      const countiesList = TARGET_COUNTIES.join(' or ');
      if (!county) {
        logger.warn(`[Filter Action] Specific address "${display_name}" OK but LocationIQ did not return county information. Cannot verify target county.`);
      } else {
        logger.warn(`[Filter Action] Specific address "${display_name}" OK but geocoded county "${county}" is not within target counties: ${countiesList}.`);
      }
      return null;
    }

    // 6b. Target City Filtering (only if a TARGET_CITIES_LIST was configured).
    if (TARGET_CITY_SET.size) {
      const cityName = addressDetails.city || addressDetails.town || addressDetails.village
        || addressDetails.hamlet || addressDetails.municipality || '';
      if (!isTargetCity(cityName)) {
        logger.warn(`[Filter Action] Address "${display_name}" is in target county but city "${cityName || 'unknown'}" is not in TARGET_CITIES_LIST. Skipping (won't plot).`);
        return null;
      }
    }

    // 7. Success: Return Formatted Result
    logger.info(`Geocoded Address: "${display_name}" with coordinates (${lat}, ${lon}) in ${county}`);
    return {
        lat: lat,
        lng: lon,
        formatted_address: display_name,
        county: county
    };

  } catch (error) {
    logger.error(`Unexpected error in geocodeAddressWithLocationIQ for query "${address}": ${error.message}`, { stack: error.stack });
    return null;
  }
}

async function geocodeAddressWithGoogleMaps(address) {
  const endpoint = `https://maps.googleapis.com/maps/api/geocode/json`;
  
  const params = new URLSearchParams({
    address: address,
    key: GOOGLE_MAPS_API_KEY,
    components: `country:${process.env.GEOCODING_COUNTRY}|administrative_area:${process.env.GEOCODING_STATE}`
  });

  try {
    const response = await fetch(`${endpoint}?${params.toString()}`);
    if (!response.ok) {
      logger.error(`Geocoding API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      logger.warn(`Geocoding API returned status: ${data.status} for address: "${address}"`);
      return null;
    }
    
    // Find the most specific result (preferring street_address over locality)
    const preferredTypes = ['street_address', 'premise', 'subpremise', 'route', 'intersection', 'establishment', 'point_of_interest'];
    let bestResult = null;
    
    // First try to find results with preferred types
    for (const type of preferredTypes) {
      const matchingResult = data.results.find(r => r.types.includes(type));
      if (matchingResult) {
        bestResult = matchingResult;
        break;
      }
    }
    
    // If no preferred type found, use the first result
    const result = bestResult || data.results[0];
    const { lat, lng } = result.geometry.location;
    const formatted_address = result.formatted_address;
    const resultTypes = result.types;

    // Skip generic city-level results
    if (formatted_address.match(new RegExp(`^${process.env.GEOCODING_CITY}, ${process.env.GEOCODING_STATE} \\d{5}, USA$`))) {
      logger.info(`Skipping city-level result for ${process.env.GEOCODING_CITY}: "${formatted_address}"`);
      return null;
    }

    // Skip only generic city-level results while keeping useful partial matches
    if (resultTypes.includes('locality') && resultTypes.length <= 3 && !formatted_address.includes('Caravan')) {
      logger.info(`Skipping city-level result: "${formatted_address}"`);
      return null;
    }
    
    // Check for county-level results
    if (TARGET_COUNTIES.some(county => formatted_address === `${county}, ${process.env.GEOCODING_STATE}, USA`) || 
        (resultTypes.includes('administrative_area_level_2') && resultTypes.length <= 3)) {
      logger.info(`Skipping county-level result: "${formatted_address}"`);
      return null;
    }

    // Verify that the result is in one of the target counties (normalized match).
    const countyComponent = result.address_components.find(component =>
      component.types.includes('administrative_area_level_2')
    );
    const county = countyComponent ? countyComponent.long_name : null;

    if (!county || !isTargetCounty(county)) {
      const countiesList = TARGET_COUNTIES.join(' or ');
      logger.warn(`Geocoded address "${formatted_address}" (county: ${county || 'unknown'}) is not within ${countiesList}.`);
      return null;
    }

    // Target City Filtering (only when a TARGET_CITIES_LIST is configured).
    if (TARGET_CITY_SET.size) {
      const localityComponent = result.address_components.find(component =>
        component.types.includes('locality') || component.types.includes('sublocality')
        || component.types.includes('administrative_area_level_3')
      );
      const cityName = localityComponent ? localityComponent.long_name : '';
      if (!isTargetCity(cityName)) {
        logger.warn(`Address "${formatted_address}" is in target county but city "${cityName || 'unknown'}" is not in TARGET_CITIES_LIST. Skipping (won't plot).`);
        return null;
      }
    }

    logger.info(`Geocoded Address: "${formatted_address}" with coordinates (${lat}, ${lng}) in ${county}`);
    return { lat, lng, formatted_address, county };
  } catch (error) {
    logger.error(`Error geocoding address "${address}": ${error.message}`);
    return null;
  }
}


/**
 * Hyperlinks an address within the transcript text using coordinates.
 * @param {string} transcript - The transcript text.
 * @param {string} address - The address text to find and replace.
 * @param {number} lat - Latitude.
 * @param {number} lng - Longitude.
 * @returns {string} - Transcription with hyperlinked address.
 */
function hyperlinkAddress(transcript, address, lat, lng) {
  // Use a generic Google Maps URL with coordinates for the link
  if (!address || address.trim() === '' || lat === null || lng === null) {
    return transcript;
  }

  const encodedCoords = `${lat},${lng}`;
  // Link to Google Maps centered on the coordinates
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodedCoords}`;

  try {
      // Use a global, case-insensitive regex to replace all instances of the plain address text
      // Escape special regex characters in the address string
      const escapedAddress = escapeRegExp(address);
      const regex = new RegExp(`\\b${escapedAddress}\\b`, 'gi');
      // Replace with Markdown link using the coordinate-based URL
      return transcript.replace(regex, `[${address}](${mapUrl})`);
  } catch (e) {
      logger.error(`Error creating regex for hyperlinking address "${address}": ${e.message}`);
      return transcript; // Return original transcript if regex fails
  }
}


/**
 * Extracts potential addresses from a transcript using local LLM. (remains the same)
 * @param {string} transcript - The transcript text.
 * @param {string} talkGroupId - The talk group ID associated with the transcript.
 * @param {string} [systemName] - Radio system label (disambiguates overlapping ids).
 * @returns {Promise<string|null>} - Extracted and completed addresses or null if none are found.
 */
async function extractAddress(transcript, talkGroupId, systemName) {
  // Pull per-talkgroup context (county from the imported talk_groups table),
  // preferring the system-scoped entry so overlapping ids resolve correctly.
  const sysKey = String(systemName || '').trim().toLowerCase();
  const meta = (sysKey && TALK_GROUP_META[`${sysKey}:${talkGroupId}`]) || TALK_GROUP_META[talkGroupId] || {};
  const legacyTown = TALK_GROUPS[talkGroupId]; // explicit TALK_GROUP_<id> env override (rare)

  const descriptiveTownForLog = meta.county
    ? `${meta.county}, ${GEOCODING_STATE}`
    : (legacyTown || `${TARGET_COUNTIES.join(' or ')}, ${GEOCODING_STATE}`);
  logger.info(`Extracting address for talk group ID: ${talkGroupId} (${descriptiveTownForLog})`);

  // Town used by the LLM to COMPLETE partial addresses. Only trust an explicit
  // env-provided town; a talkgroup's alpha_tag (e.g. "City PD Dispatch") is a
  // channel name, not a place, so we default to the primary GEOCODING_CITY.
  let townForLLMPrompt = GEOCODING_CITY;
  if (legacyTown &&
      !legacyTown.toLowerCase().includes('county') &&
      !legacyTown.toLowerCase().includes(' or ')) {
    townForLLMPrompt = legacyTown;
  }

  let extractedAddress = await extractAddressWithLLM(transcript, townForLLMPrompt);

  if (!extractedAddress) {
    return null;
  }

  // Clean up potentially messy LLM responses (remains the same)
  extractedAddress = extractedAddress
    .replace(/\([^)]*\)/g, '')
    .replace(/Note:.*$/i, '')
    .replace(/Town Not Specified/gi, GEOCODING_CITY)
    .trim();

  if (extractedAddress.split(',').length > 3 || extractedAddress.includes('\n')) {
    const firstLine = extractedAddress.split('\n')[0].trim();
    const firstPart = extractedAddress.split(',').slice(0, 3).join(',').trim();
    extractedAddress = firstLine.length < firstPart.length ? firstLine : firstPart;
    logger.warn(`Fixed malformed address response from LLM: "${extractedAddress}"`);
  }

  extractedAddress = extractedAddress.replace(/(?<=\d),(?=\d)/g, '');
  extractedAddress = extractedAddress.replace(/(?<=\d)-(?=\d)/g, '');
  extractedAddress = extractedAddress
    .replace(/\bAvenue\b/gi, 'Ave')
    .replace(/\bRoad\b/gi, 'Rd')
    .replace(/\bStreet\b/gi, 'St')
    .replace(/\bDrive\b/gi, 'Dr')
    .replace(/\bBoulevard\b/gi, 'Blvd')
    .replace(/\bLane\b/gi, 'Ln')
    .replace(/\bPlace\b/gi, 'Pl')
    .replace(/\bParkway\b/gi, 'Pkwy')
    .replace(/\bHighway\b/gi, 'Hwy');

  if (!extractedAddress.includes(GEOCODING_STATE)) {
    extractedAddress += `, ${GEOCODING_STATE}`;
  }
  extractedAddress = extractedAddress.trim();

  if (!looksLikePlausibleAddress(extractedAddress)) {
    logger.info(`Rejected implausible LLM address (no street/place structure): "${extractedAddress}"`);
    return null;
  }
  if (!addressAnchoredInTranscript(extractedAddress, transcript)) {
    logger.info(`Rejected LLM address not anchored in transcript (possible hallucination): "${extractedAddress}"`);
    return null;
  }

  // Second-pass LLM sanity check (does this address actually make sense for the
  // transcript?). Catches subtle mistakes the structural checks above can't.
  const verified = await verifyAddressWithLLM(extractedAddress, transcript);
  if (!verified) {
    return null;
  }

  // LLM extraction log moved inside extractAddressWithLLM
  // logger.info(`Extracted Address for ID ${talkGroupId}: ${extractedAddress}`);
  return extractedAddress;
}


/**
 * Processes a transcript to extract and geocode addresses.
 * Note: Now relies on the updated geocodeAddress and hyperlinkAddress.
 * @param {string} transcript - The transcript text.
 * @param {string} talkGroupId - The talk group ID associated with the transcript.
 * @returns {Promise<{ geocodedResult: { lat: number, lng: number, formatted_address: string, county: string }, linkedTranscript: string } | null>} - Geocoded data and updated transcript or null.
 */
async function processTranscriptAndLink(transcript, talkGroupId) {
  // Verify the AI backend is reachable (only relevant for local Ollama).
  if (AI_PROVIDER.toLowerCase() === 'ollama') {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/version`);
      if (!response.ok) {
        logger.error('Ollama server is not responding properly');
        return null;
      }
    } catch (error) {
      logger.error(`Ollama server connection error: ${error.message}. Make sure Ollama is running at ${OLLAMA_URL}`);
      return null;
    }
  }

  const extractedAddress = await extractAddress(transcript, talkGroupId);

  if (!extractedAddress) {
    logger.info('No valid address extracted from transcript.');
    return null; // Return null if no address extracted
  }

  // Geocode the single extracted address
  const geocodeResult = await geocodeAddress(extractedAddress);

  if (geocodeResult) {
    // Hyperlink the address in the original transcript using the geocoded coordinates
    const linkedTranscript = hyperlinkAddress(transcript, geocodeResult.formatted_address, geocodeResult.lat, geocodeResult.lng);
    return { geocodedResult: geocodeResult, linkedTranscript: linkedTranscript };
  } else {
    logger.warn(`Failed to geocode extracted address: "${extractedAddress}"`);
    return null; // Return null if geocoding failed
  }
}


module.exports = {
  extractAddress,
  geocodeAddress,
  hyperlinkAddress, // Note: Signature changed slightly if used directly
  processTranscriptAndLink, // Renamed for clarity, returns linked text now
  processTranscript: processTranscriptAndLink, // Alias for backward compatibility
  loadTalkGroups
};