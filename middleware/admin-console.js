import { AppError } from '../utils/error-handler.js';
import { isValidRouteModule, canAccessRouteModule } from '../constants/admin-modules.js';
import { hasTeamAction, modulesFromAccess } from '../constants/admin-actions.js';

/**
 * After authenticate + authorize('ADMIN','ADMIN_TEAM').
 * ADMIN: always allowed.
 * ADMIN_TEAM: deny-by-default. Supports legacy string[] or action-map adminModules.
 */
function checkConsoleModuleAccess(user, moduleSlug) {
  const { role, adminModules } = user || {};
  if (role === 'ADMIN') return true;
  if (role !== 'ADMIN_TEAM') return false;
  const alwaysAllowed =
    moduleSlug === 'dashboard' ||
    moduleSlug === 'profile' ||
    moduleSlug === 'notifications';
  if (adminModules === null || adminModules === undefined) return alwaysAllowed;

  const isArray = Array.isArray(adminModules);
  const isMap = Boolean(adminModules) && typeof adminModules === 'object' && !isArray;
  if (!isArray && !isMap) return false;

  if (isArray && adminModules.length === 0) return alwaysAllowed;
  if (isMap && modulesFromAccess(adminModules).length === 0) return alwaysAllowed;

  return alwaysAllowed || canAccessRouteModule(adminModules, moduleSlug);
}

export function requireConsoleModule(moduleSlug) {
  return (req, res, next) => {
    if (!isValidRouteModule(moduleSlug)) {
      next(new AppError(500, 'Invalid server route module configuration'));
      return;
    }
    try {
      if (!req.user) {
        next(new AppError(403, 'Forbidden'));
        return;
      }
      if (checkConsoleModuleAccess(req.user, moduleSlug)) {
        next();
        return;
      }
      next(new AppError(403, 'Forbidden'));
    } catch (e) {
      next(e);
    }
  };
}

/** Allow ADMIN_TEAM with any of the listed route modules (e.g. inspection + returns). */
export function requireConsoleModuleAny(moduleSlugs) {
  const slugs = Array.isArray(moduleSlugs) ? moduleSlugs : [moduleSlugs];
  return (req, res, next) => {
    for (const slug of slugs) {
      if (!isValidRouteModule(slug)) {
        next(new AppError(500, 'Invalid server route module configuration'));
        return;
      }
    }
    try {
      if (!req.user) {
        next(new AppError(403, 'Forbidden'));
        return;
      }
      if (slugs.some((slug) => checkConsoleModuleAccess(req.user, slug))) {
        next();
        return;
      }
      next(new AppError(403, 'Forbidden'));
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Action-level gate. ADMIN always passes.
 * @param {string} teamModule e.g. 'order-management'
 * @param {string} actionId e.g. 'cancel'
 */
export function requireTeamAction(teamModule, actionId) {
  return (req, res, next) => {
    try {
      if (!req.user) {
        next(new AppError(403, 'Forbidden'));
        return;
      }
      if (req.user.role === 'ADMIN') {
        next();
        return;
      }
      if (req.user.role !== 'ADMIN_TEAM') {
        next(new AppError(403, 'Forbidden'));
        return;
      }
      if (hasTeamAction(req.user.adminModules, teamModule, actionId)) {
        next();
        return;
      }
      next(new AppError(403, 'Forbidden', 'MISSING_TEAM_ACTION'));
    } catch (e) {
      next(e);
    }
  };
}
