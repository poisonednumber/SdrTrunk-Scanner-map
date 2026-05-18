const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkWritableDir } = require('../src/setup/checks');

test('checkWritableDir creates and verifies writable directories', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-map-check-'));
  const nested = path.join(tempDir, 'data');

  const result = checkWritableDir(nested);

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(nested), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
