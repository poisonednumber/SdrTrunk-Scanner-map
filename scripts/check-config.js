try {
  require('dotenv').config();
} catch {
  // Allows this checker to run before npm install; CI still installs dependencies.
}

const { loadConfig, redactConfig } = require('../src/config');

const result = loadConfig(process.env);

if (!result.isValid) {
  console.error('Configuration validation failed:');
  for (const error of result.errors) {
    console.error(`- ${error.key}: ${error.message}`);
  }
  process.exit(1);
}

console.log('Configuration looks valid.');
console.log(JSON.stringify(redactConfig(result.config), null, 2));
