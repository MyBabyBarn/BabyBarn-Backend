/**
 * Action-level team permissions (HTML prototype MOD.*.acts).
 * Stored on User.adminModules as either:
 * - legacy: string[] of TEAM_PERMISSION_MODULES (treated as full access to that module)
 * - modern: Record<teamModuleSlug, string[]> of action ids
 */

export const TEAM_MODULE_ACTIONS = {
  'product-management': [
    { id: 'view', label: 'View products', tier: 1 },
    { id: 'create', label: 'Add products', tier: 2 },
    { id: 'edit', label: 'Edit product details', tier: 2 },
    { id: 'publish', label: 'Activate / deactivate', tier: 2 },
    { id: 'delete', label: 'Delete products', tier: 3 },
    { id: 'export', label: 'Export product list', tier: 3 },
  ],
  'inventory-management': [
    { id: 'view', label: 'View inventory levels', tier: 1 },
    { id: 'adjust', label: 'Update stock quantity', tier: 2 },
    { id: 'count', label: 'Stock count', tier: 2 },
    { id: 'transfer', label: 'Transfer stock between locations', tier: 2 },
    { id: 'locations', label: 'Edit location labels', tier: 2 },
    { id: 'barcodes', label: 'Generate & print barcodes', tier: 2 },
    { id: 'export', label: 'Export inventory ledger', tier: 3 },
  ],
  'order-management': [
    { id: 'view', label: 'View orders and details', tier: 1 },
    { id: 'create', label: 'Create orders', tier: 2 },
    { id: 'status', label: 'Update order status', tier: 2 },
    { id: 'label', label: 'Generate & print shipping labels', tier: 2 },
    { id: 'pick', label: 'Pick & dispatch with scanner', tier: 2 },
    { id: 'cancel', label: 'Cancel orders', tier: 3 },
    { id: 'export', label: 'Export orders', tier: 3 },
  ],
  'returns-refurbishment': [
    { id: 'view', label: 'View return requests', tier: 1 },
    { id: 'inspect', label: 'Inspect items and add notes', tier: 2 },
    { id: 'decide', label: 'Approve / reject returns', tier: 2 },
    { id: 'restock', label: 'Restock or move to refurbishment', tier: 2 },
    { id: 'export', label: 'Export returns', tier: 3 },
  ],
  'finance-management': [
    { id: 'view', label: 'View financial records', tier: 1 },
    { id: 'edit', label: 'Edit financial records', tier: 2 },
    { id: 'refund', label: 'Approve refunds', tier: 3 },
    { id: 'credit', label: 'Adjust store credit', tier: 3 },
    { id: 'export', label: 'Export reports', tier: 3 },
  ],
  'membership-management': [
    { id: 'view', label: 'View members and status', tier: 1 },
    { id: 'export', label: 'Export members', tier: 3 },
  ],
  'user-management': [
    { id: 'view', label: 'View customer profiles', tier: 1 },
    { id: 'history', label: 'View customer order history', tier: 1 },
    { id: 'edit', label: 'Edit customer details', tier: 2 },
    { id: 'export', label: 'Export customers', tier: 3 },
  ],
  'content-management': [
    { id: 'view', label: 'View content', tier: 1 },
    { id: 'edit', label: 'Edit content', tier: 2 },
    { id: 'publish', label: 'Publish content', tier: 2 },
  ],
  'activity-log': [
    { id: 'view', label: 'View activity logs', tier: 1 },
    { id: 'export', label: 'Export activity logs', tier: 3 },
  ],
};

export function actionIdsForModule(teamModule) {
  return (TEAM_MODULE_ACTIONS[teamModule] || []).map((a) => a.id);
}

export function isActionMap(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Normalize stored adminModules into Record<module, actionId[]>. */
export function normalizeAdminAccess(adminModules) {
  if (adminModules == null) return {};
  if (Array.isArray(adminModules)) {
    const out = {};
    for (const slug of adminModules) {
      if (typeof slug !== 'string' || !TEAM_MODULE_ACTIONS[slug]) continue;
      out[slug] = actionIdsForModule(slug);
    }
    return out;
  }
  if (!isActionMap(adminModules)) return {};
  const out = {};
  for (const [slug, actions] of Object.entries(adminModules)) {
    if (!TEAM_MODULE_ACTIONS[slug]) continue;
    const allowed = new Set(actionIdsForModule(slug));
    const list = Array.isArray(actions)
      ? actions.filter((a) => typeof a === 'string' && allowed.has(a))
      : [];
    if (list.length) out[slug] = [...new Set(list)];
  }
  return out;
}

/** Module list for route-level checks (backward compatible). */
export function modulesFromAccess(adminModules) {
  return Object.keys(normalizeAdminAccess(adminModules));
}

export function hasTeamAction(adminModules, teamModule, actionId) {
  const access = normalizeAdminAccess(adminModules);
  const actions = access[teamModule];
  if (!actions || !actions.length) return false;
  return actions.includes(actionId);
}

/** Expand legacy array grants to full action map for API responses. */
export function serializeAdminAccess(adminModules) {
  return normalizeAdminAccess(adminModules);
}
