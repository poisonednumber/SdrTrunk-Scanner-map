const test = require('node:test');
const assert = require('node:assert/strict');

const { getMigrationPlan } = require('../src/db/migrations');

test('migration plan includes core tables by default', () => {
  assert.deepEqual(
    getMigrationPlan({ enableAuth: false }).map((migration) => migration.id),
    ['001_create_core_tables']
  );
});

test('migration plan includes auth tables when auth is enabled', () => {
  assert.deepEqual(
    getMigrationPlan({ enableAuth: true }).map((migration) => migration.id),
    ['001_create_core_tables', '002_create_auth_tables']
  );
});
