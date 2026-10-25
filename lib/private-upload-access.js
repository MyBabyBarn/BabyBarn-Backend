import { AppError } from '../utils/error-handler.js';
import { verifyToken } from '../utils/jwt.js';
import { prisma } from './prisma.js';
import { canAccessRouteModule } from '../constants/admin-modules.js';

const SAFE_FILE = /^[A-Za-z0-9._-]+$/;

export function isPrivateUploadPath(rel) {
  const path = String(rel || '').replace(/\\/g, '/').toLowerCase();
  return (
    path === '/returns' ||
    path.startsWith('/returns/') ||
    path === '/shipping-labels' ||
    path.startsWith('/shipping-labels/')
  );
}

function privateFileName(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts[parts.length - 1] || '';
  if (!SAFE_FILE.test(name) || name.includes('..')) return null;
  return name;
}

function readRequestToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  const queryToken = req.query?.token;
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();
  return null;
}

function staffCanRead(user, kind) {
  if (user.role === 'ADMIN') return true;
  if (user.role !== 'ADMIN_TEAM') return false;
  const needed = kind === 'label' ? ['orders', 'shipping', 'returns', 'finance'] : ['returns', 'inspection', 'finance'];
  return needed.some((slug) => canAccessRouteModule(user.adminModules, slug));
}

async function customerOwnsReturnPhoto(userId, filename) {
  const like = `%${filename}%`;
  const rows = await prisma.$queryRaw`
    SELECT r.id
    FROM "ReturnRequest" r
    LEFT JOIN "ReturnEligibilityQuestionnaire" q ON q."returnRequestId" = r.id
    WHERE r."userId" = ${userId}
      AND (
        COALESCE(r."photoUrlsJson"::text, '') ILIKE ${like}
        OR COALESCE(q."photoUrlsJson"::text, '') ILIKE ${like}
      )
    LIMIT 1
  `;
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * SEC-05: return photos and shipping labels are not public.
 * A valid session is required. Labels are staff-only. Return photos are staff or the owner.
 */
export async function assertPrivateUploadAccess(req, rel) {
  const token = readRequestToken(req);
  if (!token) {
    throw new AppError(401, 'Sign in to view this file');
  }
  const decoded = verifyToken(token);
  const user = await prisma.user.findUnique({
    where: { publicId: decoded.id },
    select: { id: true, isActive: true, role: { select: { name: true } }, adminModules: true },
  });
  if (!user || user.isActive === false) {
    throw new AppError(401, 'Sign in to view this file');
  }
  const actor = { role: user.role?.name, adminModules: user.adminModules };
  const kind = String(rel).toLowerCase().includes('shipping-labels') ? 'label' : 'return';
  if (staffCanRead(actor, kind)) return;

  if (kind === 'label') {
    throw new AppError(403, 'Forbidden');
  }
  const filename = privateFileName(rel);
  if (!filename || !(await customerOwnsReturnPhoto(user.id, filename))) {
    throw new AppError(403, 'Forbidden');
  }
}
