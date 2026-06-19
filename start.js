#!/usr/bin/env node
'use strict';

/**
 * Smart entrypoint.
 *
 *   - If initial setup is NOT complete  -> start only the web Setup Wizard.
 *   - Once setup IS complete            -> start the full app (bot.js), which
 *                                          also launches the web map server.
 *
 * This lets a fresh install be configured from the browser at /setup before
 * any API keys / Discord token / transcription config exist.
 */

require('dotenv').config();
const { isSetupComplete } = require('./src/setup/envFile');

if (!isSetupComplete()) {
  require('./src/setup/server').startSetupServer();
} else {
  require('./bot.js');
}
