/** Route-level module slugs used by middleware on concrete API routes. */
export const ADMIN_CONSOLE_ROUTE_MODULES = [
  'dashboard',
  'categories',
  'products',
  'refurbished',
  'inventory',
  'orders',
  'shipping',
  'returns',
  'inspection',
  'store-credit',
  'access',
  'customers',
  'finance',
  'team',
  'activity',
  'profile',
  'notifications',
  'homepage',
  'blog',
  'reviews',
];

/** Business-facing team permission modules (coarse-grained, no granular permissions). */
export const TEAM_PERMISSION_MODULES = [
  'product-management',
  'inventory-management',
  'order-management',
  'returns-refurbishment',
  'finance-management',
  'membership-management',
  'user-management',
  'content-management',
  // FMA-01 / REQ-02: Activity Log is its own assignable module (not bundled with finance).
  'activity-log',
];

export const TEAM_PERMISSION_TO_ROUTE_MODULES = {
  // Category management is ADMIN-only (like Team Management); team members with
  // product-management can manage products/refurbished but never categories.
  'product-management': ['products', 'refurbished'],
  'inventory-management': ['inventory', 'inspection'],
  'order-management': ['orders', 'shipping'],
  'returns-refurbishment': ['returns', 'inspection'],
  'finance-management': ['finance', 'store-credit'],
  'membership-management': ['access'],
  'user-management': ['customers'],
  'content-management': ['homepage', 'blog', 'reviews'],
  'activity-log': ['activity'],
};

export function isValidRouteModule(slug) {
  return typeof slug === 'string' && ADMIN_CONSOLE_ROUTE_MODULES.includes(slug);
}

export function isValidTeamPermissionModule(slug) {
  return typeof slug === 'string' && TEAM_PERMISSION_MODULES.includes(slug);
}

export function normalizeTeamPermissionModules(modules) {
  if (modules == null) return null;
  if (!Array.isArray(modules)) return [];
  return [...new Set(modules.filter((m) => isValidTeamPermissionModule(m)))];
}

export function canAccessRouteModule(assignedModules, routeModule) {
  // Deny-by-default: null/undefined modules grant no mapped route access.
  // Always-allowed slugs (dashboard/profile/notifications) are handled by callers.
  if (assignedModules == null) return false;
  if (!Array.isArray(assignedModules)) return false;
  if (assignedModules.length === 0) return false;
  if (assignedModules.includes(routeModule)) return true;
  return assignedModules.some((teamModule) =>
    (TEAM_PERMISSION_TO_ROUTE_MODULES[teamModule] || []).includes(routeModule)
  );
}
