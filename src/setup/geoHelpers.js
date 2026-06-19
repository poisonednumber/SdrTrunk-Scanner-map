'use strict';

const fetch = require('node-fetch');
const { createLogger } = require('../logger');
const envFile = require('./envFile');

const log = createLogger('geo-helpers');

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

function fullStateName(state) {
  if (!state) return '';
  const up = state.trim().toUpperCase();
  if (US_STATES[up]) return US_STATES[up];
  return state.trim();
}

/**
 * Reverse geocode lat/lon to {city, state, county, country} using the
 * configured provider, falling back to OSM Nominatim (no key required).
 */
async function reverseGeocode(lat, lon) {
  const env = envFile.readValues();
  try {
    if (env.GOOGLE_MAPS_API_KEY) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${env.GOOGLE_MAPS_API_KEY}`;
      const r = await fetch(url, { timeout: 10000 });
      const j = await r.json();
      if (j.status === 'OK' && j.results[0]) {
        return parseGoogle(j.results[0], lat, lon);
      }
    }
    if (env.LOCATIONIQ_API_KEY) {
      const url = `https://us1.locationiq.com/v1/reverse?key=${env.LOCATIONIQ_API_KEY}&lat=${lat}&lon=${lon}&format=json&normalizeaddress=1`;
      const r = await fetch(url, { timeout: 10000 });
      const j = await r.json();
      if (j && j.address) return parseNominatim(j, lat, lon);
    }
  } catch (e) {
    log.warn(`provider reverse geocode failed: ${e.message}`);
  }

  // Fallback: OSM Nominatim (be polite with a UA)
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1`;
    const r = await fetch(url, { timeout: 10000, headers: { 'User-Agent': 'ScannerMap-Setup/2.0' } });
    const j = await r.json();
    if (j && j.address) return parseNominatim(j, lat, lon);
  } catch (e) {
    log.warn(`nominatim reverse geocode failed: ${e.message}`);
  }
  return { ok: false, error: 'Could not determine location', lat, lon };
}

function parseGoogle(result, lat, lon) {
  const comp = (type) =>
    (result.address_components.find((c) => c.types.includes(type)) || {}).long_name || '';
  const stateShort =
    (result.address_components.find((c) => c.types.includes('administrative_area_level_1')) || {}).short_name || '';
  return {
    ok: true,
    lat, lon,
    city: comp('locality') || comp('sublocality') || comp('administrative_area_level_3'),
    county: comp('administrative_area_level_2'),
    state: stateShort,
    country: (result.address_components.find((c) => c.types.includes('country')) || {}).short_name || '',
  };
}

function parseNominatim(j, lat, lon) {
  const a = j.address || {};
  let stateAbbr = a.state || '';
  for (const [abbr, name] of Object.entries(US_STATES)) {
    if (name.toLowerCase() === String(a.state || '').toLowerCase()) { stateAbbr = abbr; break; }
  }
  return {
    ok: true,
    lat, lon,
    city: a.city || a.town || a.village || a.hamlet || a.municipality || '',
    county: a.county || '',
    state: stateAbbr,
    country: (a.country_code || '').toUpperCase(),
  };
}

/**
 * Forward geocode a free-text query (city or address) to coordinates.
 * Works WITHOUT any API key by falling back to OSM Nominatim, so it can be used
 * on the very first wizard step before a provider key is entered.
 * @param {string} query
 */
async function forwardGeocode(query) {
  const q = (query || '').toString().trim();
  if (q.length < 3) return { ok: false, error: 'Type at least 3 characters', results: [] };
  const env = envFile.readValues();
  try {
    if (env.GOOGLE_MAPS_API_KEY) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${env.GOOGLE_MAPS_API_KEY}`;
      const r = await fetch(url, { timeout: 10000 });
      const j = await r.json();
      if (j.status === 'OK') {
        return { ok: true, results: (j.results || []).slice(0, 6).map((x) => normFromGoogle(x)) };
      }
    } else if (env.LOCATIONIQ_API_KEY) {
      const url = `https://us1.locationiq.com/v1/search?key=${env.LOCATIONIQ_API_KEY}&q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=6&normalizeaddress=1`;
      const r = await fetch(url, { timeout: 10000 });
      const j = await r.json();
      if (Array.isArray(j)) return { ok: true, results: j.map((x) => normFromNominatim(x)) };
    }
  } catch (e) {
    log.warn(`provider forward geocode failed: ${e.message}`);
  }

  // Keyless fallback: OSM Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=6`;
    const r = await fetch(url, { timeout: 10000, headers: { 'User-Agent': 'ScannerMap-Setup/2.0' } });
    const j = await r.json();
    if (Array.isArray(j)) return { ok: true, results: j.map((x) => normFromNominatim(x)) };
  } catch (e) {
    log.warn(`nominatim forward geocode failed: ${e.message}`);
  }
  return { ok: false, error: 'Geocoding failed', results: [] };
}

function normFromGoogle(x) {
  const lat = x.geometry?.location?.lat;
  const lon = x.geometry?.location?.lng;
  const parsed = parseGoogle(x, lat, lon);
  return { label: x.formatted_address, lat, lon, city: parsed.city, county: parsed.county, state: parsed.state, country: parsed.country };
}

function normFromNominatim(x) {
  const lat = parseFloat(x.lat);
  const lon = parseFloat(x.lon);
  const parsed = parseNominatim(x, lat, lon);
  return { label: x.display_name, lat, lon, city: parsed.city, county: parsed.county, state: parsed.state, country: parsed.country };
}

/**
 * Fetch all populated places (city/town/village) inside the given US counties
 * using the OpenStreetMap Overpass API. Best-effort; returns a de-duped,
 * sorted list of place names.
 * @param {{state: string, counties: string[]}} params
 */
async function citiesInCounties({ state, counties }) {
  if (!counties || !counties.length) return { ok: false, error: 'No counties provided' };
  const stateName = fullStateName(state);
  const all = new Set();
  const perCounty = {};

  for (const rawCounty of counties) {
    const county = rawCounty.trim();
    if (!county) continue;
    // Ensure the county name includes "County" for matching where appropriate.
    const countyName = /county|parish|borough/i.test(county) ? county : `${county} County`;
    const query = `
      [out:json][timeout:50];
      area["name"="${stateName}"]["admin_level"="4"]->.st;
      area["name"="${countyName}"]["admin_level"="6"](area.st)->.co;
      (
        node["place"~"^(city|town|village)$"](area.co);
      );
      out tags;`;
    try {
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ScannerMap-Setup/2.0' },
        body: `data=${encodeURIComponent(query)}`,
        timeout: 60000,
      });
      if (!r.ok) { perCounty[county] = { error: `HTTP ${r.status}` }; continue; }
      const j = await r.json();
      const names = (j.elements || [])
        .map((el) => el.tags && el.tags.name)
        .filter(Boolean);
      perCounty[county] = { count: names.length };
      names.forEach((n) => all.add(n));
    } catch (e) {
      perCounty[county] = { error: e.message };
      log.warn(`Overpass failed for ${county}: ${e.message}`);
    }
  }

  return {
    ok: true,
    state: stateName,
    cities: Array.from(all).sort((a, b) => a.localeCompare(b)),
    perCounty,
  };
}

module.exports = { reverseGeocode, forwardGeocode, citiesInCounties, fullStateName };
