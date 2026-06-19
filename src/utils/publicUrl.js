'use strict';

/**
 * Normalize PUBLIC_DOMAIN from .env into a base URL without trailing slash.
 * Accepts either "http://host:port" or "host:port" (scheme added if missing).
 */
function getPublicBaseUrl(env = process.env) {
  const fallbackPort = env.WEBSERVER_PORT || '8080';
  let base = (env.PUBLIC_DOMAIN || `http://localhost:${fallbackPort}`).trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) {
    base = `http://${base}`;
  }
  return base;
}

function audioUrl(transcriptionId, env = process.env) {
  return `${getPublicBaseUrl(env)}/audio/${transcriptionId}`;
}

module.exports = { getPublicBaseUrl, audioUrl };
