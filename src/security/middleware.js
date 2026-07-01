'use strict';

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { createLogger } = require('../logger');

const log = createLogger('security');

/**
 * Content Security Policy tuned for the Leaflet map UI, which pulls tiles and
 * libraries from several CDNs. Inline scripts/styles in index.html require
 * 'unsafe-inline'. This still blocks the most common XSS payload vectors and
 * sets the rest of the helmet protections.
 */
function buildHelmet() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://unpkg.com',
          'https://cdnjs.cloudflare.com',
          'https://maps.googleapis.com',
          'https://maps.gstatic.com',
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://unpkg.com',
          'https://cdnjs.cloudflare.com',
          'https://fonts.googleapis.com',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://*.tile.openstreetmap.org',
          'https://server.arcgisonline.com',
          'https://*.basemaps.cartocdn.com',
          'https://raw.githubusercontent.com',
          'https://cdnjs.cloudflare.com',
          'https://maps.googleapis.com',
          'https://maps.gstatic.com',
          'https://*.googleapis.com',
        ],
        connectSrc: [
          "'self'",
          'https://maps.googleapis.com',
          'https://us1.locationiq.com',
          'https://*.tile.openstreetmap.org',
          'ws:',
          'wss:',
        ],
        mediaSrc: ["'self'", 'blob:', 'data:', 'https:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // Helmet defaults to "no-referrer", which strips the Referer header from map
    // tile requests. OpenStreetMap's tile usage policy now 403s any request that
    // has no Referer (Firefox is strictest about this), so tiles fail to load.
    // "strict-origin-when-cross-origin" sends only the origin (not the full path)
    // to third parties over HTTPS — enough to satisfy OSM while staying private.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

/** General API limiter (gentle; protects the web UI APIs). */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

/** Stricter limiter for auth/login attempts. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, try again later.' },
});

/** Limiter for the radio call-upload endpoint (high but bounded). */
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Upload rate limit exceeded',
});

/**
 * Apply baseline hardening to an Express app.
 * Call early, before routes.
 */
function applyBaseSecurity(app) {
  app.disable('x-powered-by');
  app.use(buildHelmet());
  app.use(compression());
  log.info('helmet + compression enabled');
}

module.exports = {
  applyBaseSecurity,
  buildHelmet,
  apiLimiter,
  authLimiter,
  uploadLimiter,
};
