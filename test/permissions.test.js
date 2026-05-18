const test = require('node:test');
const assert = require('node:assert/strict');

const { ROLES, hasPermission, permissionsForRole } = require('../src/permissions/roles');

test('admin can manage users', () => {
  assert.equal(hasPermission(ROLES.ADMIN, 'users:manage'), true);
});

test('viewer cannot update markers', () => {
  assert.equal(hasPermission(ROLES.VIEWER, 'markers:update'), false);
});

test('unknown roles fall back to viewer permissions', () => {
  assert.deepEqual(permissionsForRole('unknown'), ['calls:read', 'audio:read']);
});
