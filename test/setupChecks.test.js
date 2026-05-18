const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkWritableDir, runSetupChecks } = require('../src/setup/checks');

test('checkWritableDir creates and verifies writable directories', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-map-check-'));
  const nested = path.join(tempDir, 'data');

  const result = checkWritableDir(nested);

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(nested), true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('runSetupChecks validates provider-specific readiness from runtime config', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-map-check-'));

  const checks = await runSetupChecks({
    rootDir: tempDir,
    env: {},
    runtime: {
      settings: {
        storageMode: 's3',
        transcriptionMode: 'remote',
        aiProvider: 'openai'
      },
      secrets: {}
    }
  });

  assert.equal(checks.storageProvider.ok, false);
  assert.equal(checks.transcriptionProvider.ok, false);
  assert.equal(checks.aiProvider.ok, false);
  assert.equal(checks.uploadEndpoint.ok, false);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('runSetupChecks accepts configured S3 and provider secrets', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-map-check-'));

  const checks = await runSetupChecks({
    rootDir: tempDir,
    env: {},
    runtime: {
      settings: {
        storageMode: 's3',
        s3Endpoint: 'http://localhost:9000',
        s3BucketName: 'scanner-audio',
        transcriptionMode: 'remote',
        fasterWhisperServerUrl: 'http://localhost:8000',
        aiProvider: 'openai'
      },
      secrets: {
        s3AccessKeyId: 'key',
        s3SecretAccessKey: 'secret',
        openaiApiKey: 'openai',
        uploadApiKey: 'upload'
      }
    }
  });

  assert.equal(checks.storageProvider.ok, true);
  assert.equal(checks.transcriptionProvider.ok, true);
  assert.equal(checks.aiProvider.ok, true);
  assert.equal(checks.uploadEndpoint.ok, true);
  fs.rmSync(tempDir, { recursive: true, force: true });
});
