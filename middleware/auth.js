import { verifyToken } from '../utils/jwt.js';
import { AppError } from '../utils/error-handler.js';
import { prisma } from '../lib/prisma.js';
import { PORTAL_SCOPE, isStaffRoleName } from '../lib/portal-scope.js';

function resolvePortalScope(dbUser, decoded, roleName) {
  if (dbUser && 'portalScope' in dbUser && dbUser.portalScope) {
    return dbUser.portalScope;
  }
  if (decoded?.portalScope === PORTAL_SCOPE.STAFF || decoded?.portalScope === PORTAL_SCOPE.CUSTOMER) {
    return decoded.portalScope;
  }
  return isStaffRoleName(roleName) ? PORTAL_SCOPE.STAFF : PORTAL_SCOPE.CUSTOMER;
}

export const authenticate = async (req, res, next) => {
  try {
    void res;
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      throw new AppError(401, 'No token provided');
    }

    const decoded = verifyToken(token);
    let dbUser;
    try {
      dbUser = await prisma.user.findUnique({
        where: { publicId: decoded.id },
        select: {
          publicId: true,
          email: true,
          isActive: true,
          isGuest: true,
          portalScope: true,
          adminModules: true,
          adminNotificationAccess: true,
          tokenVersion: true,
          role: { select: { name: true } },
        },
      });
    } catch (error) {
      // Fail closed: schema lag must not skip isActive / tokenVersion revocation checks.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2022') {
        throw new AppError(
          503,
          'Authentication temporarily unavailable. Please try again shortly.',
          'AUTH_SCHEMA_UNAVAILABLE'
        );
      }
      throw error;
    }
    if (!dbUser) {
      throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
    }
    if (dbUser.isActive === false) {
      throw new AppError(403, 'This account has been deactivated.');
    }
    if (
      typeof decoded.tokenVersion === 'number' &&
      Number(dbUser.tokenVersion ?? 0) !== Number(decoded.tokenVersion)
    ) {
      throw new AppError(401, 'Session expired. Please sign in again.', 'SESSION_REVOKED');
    }
    // Legacy tokens without tokenVersion are rejected once the user has bumped version.
    if (decoded.tokenVersion == null && Number(dbUser.tokenVersion ?? 0) > 0) {
      throw new AppError(401, 'Session expired. Please sign in again.', 'SESSION_REVOKED');
    }

    const role = ('role' in dbUser ? dbUser.role?.name : null) || decoded.role;
    const portalScope = resolvePortalScope(dbUser, decoded, role);

    req.user = {
      ...decoded,
      id: dbUser.publicId,
      email: dbUser.email,
      role,
      portalScope,
      isGuest: 'isGuest' in dbUser ? Boolean(dbUser.isGuest) : false,
      adminModules: 'adminModules' in dbUser ? (dbUser.adminModules ?? null) : null,
      adminNotificationAccess:
        'adminNotificationAccess' in dbUser ? Boolean(dbUser.adminNotificationAccess) : false,
    };
    next();
  } catch (error) {
    next(error instanceof AppError ? error : new AppError(401, 'Unauthorized', 'UNAUTHORIZED'));
  }
};

/**
 * Require the authenticated user to belong to one of the given portal scopes.
 * @param {...('CUSTOMER'|'STAFF')} scopes
 */
export const requirePortalScope = (...scopes) => {
  const allowed = new Set(scopes);
  return (req, res, next) => {
    void res;
    if (!req.user) {
      return next(new AppError(401, 'Unauthorized', 'UNAUTHORIZED'));
    }
    const scope = req.user.portalScope || PORTAL_SCOPE.CUSTOMER;
    if (!allowed.has(scope)) {
      return next(
        new AppError(
          403,
          scope === PORTAL_SCOPE.STAFF
            ? 'Access denied. Use the Admin Portal session for staff tools, or sign in on the Customer Portal for shop access.'
            : 'Access denied. Use the Customer Portal session for shop access, or sign in on the Admin Portal for staff tools.',
          'WRONG_PORTAL_TOKEN'
        )
      );
    }
    next();
  };
};

export const requireFullAccount = (req, res, next) => {
  void res;
  if (!req.user) {
    return next(new AppError(401, 'Unauthorized', 'UNAUTHORIZED'));
  }
  if (req.user.scope === 'checkout') {
    return next(
      new AppError(403, 'A full account is required for this action.', 'FULL_ACCOUNT_REQUIRED')
    );
  }
  if (req.user.isGuest) {
    return next(
      new AppError(
        403,
        'Complete your account registration to access this feature.',
        'GUEST_ACCOUNT'
      )
    );
  }
  next();
};

/** Full non-guest customer session — blocks staff-portal twins from shop account APIs. */
export const requireCustomerFullAccount = [
  requireFullAccount,
  requirePortalScope(PORTAL_SCOPE.CUSTOMER),
];

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'Forbidden'));
    }
    // Staff console roles must present a STAFF-scoped session (not a customer twin).
    const needsStaffPortal = roles.some((role) => isStaffRoleName(role));
    if (needsStaffPortal) {
      const scope = req.user.portalScope || PORTAL_SCOPE.CUSTOMER;
      if (scope !== PORTAL_SCOPE.STAFF) {
        return next(
          new AppError(
            403,
            'Access denied. Sign in on the Admin Portal to access staff tools.',
            'WRONG_PORTAL_TOKEN'
          )
        );
      }
    }
    next();
  };
};
