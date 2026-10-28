/**
 * SCALE-001: shared WHERE builder for admin return list / count / stats.
 * List and count must use the same predicate.
 */

export const REFURB_ADMIN_VISIBLE_STATUSES = Object.freeze([
  'ELIGIBILITY_REVIEW',
  'APPROVED',
  'LABEL_GENERATED',
  'IN_TRANSIT',
  'RECEIVED',
  'UNDER_INSPECTION',
  'INSPECTION_APPROVED',
  'INSPECTION_REJECTED',
]);

/** Matches historical isRefurbVisibleToAdmin rules in Prisma WHERE form. */
export function buildAdminVisibleRefurbWhere() {
  return {
    OR: [
      { status: { in: [...REFURB_ADMIN_VISIBLE_STATUSES] } },
      { customerShippingSubmittedAt: { not: null } },
      { AND: [{ manualTrackingNumber: { not: null } }, { NOT: { manualTrackingNumber: '' } }] },
      {
        order: {
          returnPackageRequests: {
            some: { status: { in: ['REQUESTED', 'APPROVED', 'SENT'] } },
          },
        },
      },
    ],
  };
}

/**
 * @param {{
 *   type?: string,
 *   status?: string,
 *   statuses?: string[],
 *   search?: string,
 *   adminVisible?: boolean,
 * }} filters
 */
export function buildAdminReturnListWhere(filters = {}) {
  const and = [];

  if (filters.type) {
    and.push({ type: String(filters.type) });
  }

  const statuses = Array.isArray(filters.statuses)
    ? filters.statuses.map((s) => String(s)).filter((s) => s && s !== 'all')
    : [];
  if (statuses.length === 1) {
    and.push({ status: statuses[0] });
  } else if (statuses.length > 1) {
    and.push({ status: { in: statuses } });
  } else if (filters.status && filters.status !== 'all') {
    and.push({ status: String(filters.status) });
  }

  if (filters.adminVisible && (!filters.type || filters.type === 'REFURBISHMENT')) {
    and.push(buildAdminVisibleRefurbWhere());
  }

  const search = filters.search ? String(filters.search).trim() : '';
  if (search) {
    and.push({
      OR: [
        { publicId: { contains: search, mode: 'insensitive' } },
        { submissionPublicId: { contains: search, mode: 'insensitive' } },
        { returnNumber: { contains: search, mode: 'insensitive' } },
        { reason: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
        { order: { orderNumber: { contains: search, mode: 'insensitive' } } },
        { order: { publicId: { contains: search, mode: 'insensitive' } } },
        { orderItem: { product: { name: { contains: search, mode: 'insensitive' } } } },
        { orderItem: { product: { sku: { contains: search, mode: 'insensitive' } } } },
      ],
    });
  }

  return and.length ? { AND: and } : {};
}

export function normalizeAdminListPagination(filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const limitRaw = Number(filters.limit) || 0;
  // SCL-04: always apply a hard cap — unpaginated callers get at most 200 rows.
  const paginate = limitRaw > 0;
  const limit = paginate ? Math.min(100, Math.max(1, limitRaw)) : 200;
  const skip = paginate ? (page - 1) * limit : 0;
  return { page, limit, skip, paginate };
}
