const ROLES = {
  VIEWER: 'viewer',
  EDITOR: 'editor',
  MODERATOR: 'moderator',
  ADMIN: 'admin'
};

const ROLE_PERMISSIONS = {
  [ROLES.VIEWER]: ['calls:read', 'audio:read'],
  [ROLES.EDITOR]: ['calls:read', 'audio:read', 'markers:update'],
  [ROLES.MODERATOR]: ['calls:read', 'audio:read', 'markers:update', 'calls:purge'],
  [ROLES.ADMIN]: ['calls:read', 'audio:read', 'markers:update', 'calls:purge', 'users:manage', 'sessions:manage']
};

function permissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS[ROLES.VIEWER];
}

function hasPermission(role, permission) {
  return permissionsForRole(role).includes(permission);
}

module.exports = {
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  permissionsForRole
};
