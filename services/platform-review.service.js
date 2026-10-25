import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { rowsToCsv } from '../lib/csv-safe.js';

function clampRating(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new AppError(400, `${label} must be an integer from 1 to 5`);
  }
  return n;
}

function normalizeFeedback(raw) {
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  if (text.length > 4000) throw new AppError(400, 'Feedback must be at most 4000 characters');
  return text || null;
}

function displayName(user) {
  const parts = [user?.firstName, user?.lastName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return user?.email?.split('@')[0] || 'Customer';
}

async function customerUserId(user) {
  const publicId = user?.id || user?.publicId;
  if (!publicId) throw new AppError(401, 'Sign in required');
  const row = await prisma.user.findUnique({
    where: { publicId: String(publicId) },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (!row) throw new AppError(401, 'Sign in required');
  return row;
}

function toPlatformReview(row) {
  const returnRequestId = row.returnRequest?.publicId || undefined;
  return {
    id: row.publicId,
    returnRequestId,
    returnNumber: row.returnRequest?.returnNumber || null,
    returnRequest: row.returnRequest
      ? {
          id: row.returnRequest.publicId,
          returnNumber: row.returnRequest.returnNumber || null,
          status: row.returnRequest.status || null,
          type: row.returnRequest.type || null,
        }
      : null,
    returnExperienceRating: row.returnExperienceRating,
    storeCreditExperienceRating: row.storeCreditExperienceRating,
    overallPlatformRating: row.overallPlatformRating,
    feedback: row.feedback,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    customer: row.user
      ? {
          id: row.user.publicId,
          email: row.user.email,
          name: displayName(row.user),
        }
      : undefined,
  };
}

const completedRefurbWhere = {
  type: 'REFURBISHMENT',
  status: 'INSPECTION_APPROVED',
};

export async function getPlatformReviewEligibility(user) {
  const me = await customerUserId(user);
  const returns = await prisma.returnRequest.findMany({
    where: { userId: me.id, ...completedRefurbWhere },
    orderBy: { updatedAt: 'desc' },
    include: {
      platformReview: true,
      order: { select: { publicId: true, orderNumber: true } },
      orderItem: {
        select: {
          product: { select: { publicId: true, name: true, slug: true } },
        },
      },
    },
  });

  return {
    items: returns.map((r) => ({
      returnRequestId: r.publicId,
      returnNumber: r.returnNumber,
      creditAwarded: r.creditAwarded,
      completedAt: r.inspectionApprovedAt || r.updatedAt,
      orderNumber: r.order?.orderNumber || null,
      product: r.orderItem?.product
        ? {
            id: r.orderItem.product.publicId,
            name: r.orderItem.product.name,
            slug: r.orderItem.product.slug,
          }
        : null,
      existingReview: r.platformReview
        ? toPlatformReview({ ...r.platformReview, returnRequest: r, user: me })
        : null,
      canSubmit: !r.platformReview,
      canUpdate: Boolean(r.platformReview),
    })),
  };
}

export async function createPlatformReview(user, body) {
  const me = await customerUserId(user);
  const returnPublicId = String(body?.returnRequestId || '').trim();
  if (!returnPublicId) throw new AppError(400, 'returnRequestId is required');

  const ret = await prisma.returnRequest.findFirst({
    where: { publicId: returnPublicId, userId: me.id, ...completedRefurbWhere },
  });
  if (!ret) {
    throw new AppError(403, 'Platform reviews are only available after a completed refurbishment return');
  }

  const existing = await prisma.platformReview.findUnique({ where: { returnRequestId: ret.id } });
  if (existing) {
    throw new AppError(409, 'You already submitted feedback for this return. Update it instead.');
  }

  const row = await prisma.platformReview.create({
    data: {
      userId: me.id,
      returnRequestId: ret.id,
      returnExperienceRating: clampRating(body.returnExperienceRating, 'Return experience rating'),
      storeCreditExperienceRating: clampRating(body.storeCreditExperienceRating, 'Store credit experience rating'),
      overallPlatformRating: clampRating(body.overallPlatformRating, 'Overall platform rating'),
      feedback: normalizeFeedback(body.feedback),
    },
    include: {
      user: { select: { publicId: true, email: true, firstName: true, lastName: true } },
      returnRequest: { select: { publicId: true, returnNumber: true } },
    },
  });
  return toPlatformReview(row);
}

export async function updatePlatformReview(user, publicId, body) {
  const me = await customerUserId(user);
  const existing = await prisma.platformReview.findFirst({
    where: { publicId: String(publicId), userId: me.id },
    include: {
      returnRequest: { select: { publicId: true, returnNumber: true } },
    },
  });
  if (!existing) throw new AppError(404, 'Platform review not found');

  const data = {};
  if (body.returnExperienceRating != null) {
    data.returnExperienceRating = clampRating(body.returnExperienceRating, 'Return experience rating');
  }
  if (body.storeCreditExperienceRating != null) {
    data.storeCreditExperienceRating = clampRating(
      body.storeCreditExperienceRating,
      'Store credit experience rating'
    );
  }
  if (body.overallPlatformRating != null) {
    data.overallPlatformRating = clampRating(body.overallPlatformRating, 'Overall platform rating');
  }
  if (body.feedback !== undefined) data.feedback = normalizeFeedback(body.feedback);

  const row = await prisma.platformReview.update({
    where: { id: existing.id },
    data,
    include: {
      user: { select: { publicId: true, email: true, firstName: true, lastName: true } },
      returnRequest: { select: { publicId: true, returnNumber: true } },
    },
  });
  return toPlatformReview(row);
}

export async function listAdminPlatformReviews({ search, page = 1, limit = 20 } = {}) {
  const take = Math.min(100, Math.max(1, Number(limit) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const where = {};
  if (search && String(search).trim()) {
    const q = String(search).trim();
    where.OR = [
      { feedback: { contains: q, mode: 'insensitive' } },
      { user: { email: { contains: q, mode: 'insensitive' } } },
      { user: { firstName: { contains: q, mode: 'insensitive' } } },
      { user: { lastName: { contains: q, mode: 'insensitive' } } },
      { returnRequest: { returnNumber: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const [rows, total, agg] = await Promise.all([
    prisma.platformReview.findMany({
      where,
      include: {
        user: { select: { publicId: true, email: true, firstName: true, lastName: true } },
        returnRequest: { select: { publicId: true, returnNumber: true, status: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (currentPage - 1) * take,
      take,
    }),
    prisma.platformReview.count({ where }),
    prisma.platformReview.aggregate({
      where,
      _avg: {
        overallPlatformRating: true,
        returnExperienceRating: true,
        storeCreditExperienceRating: true,
      },
      _count: { _all: true },
    }),
  ]);

  return {
    summary: {
      totalReviews: agg._count._all || 0,
      averageOverall: agg._avg.overallPlatformRating
        ? Math.round(agg._avg.overallPlatformRating * 10) / 10
        : null,
      averageReturnExperience: agg._avg.returnExperienceRating
        ? Math.round(agg._avg.returnExperienceRating * 10) / 10
        : null,
      averageStoreCreditExperience: agg._avg.storeCreditExperienceRating
        ? Math.round(agg._avg.storeCreditExperienceRating * 10) / 10
        : null,
    },
    items: rows.map(toPlatformReview),
    pagination: { page: currentPage, limit: take, total, pages: Math.ceil(total / take) || 1 },
  };
}

export async function getAdminPlatformReview(publicId) {
  const row = await prisma.platformReview.findFirst({
    where: { publicId: String(publicId) },
    include: {
      user: { select: { publicId: true, email: true, firstName: true, lastName: true } },
      returnRequest: { select: { publicId: true, returnNumber: true, status: true, type: true } },
    },
  });
  if (!row) throw new AppError(404, 'Platform review not found');
  return toPlatformReview(row);
}

export async function exportAdminPlatformReviewsCsv() {
  const rows = await prisma.platformReview.findMany({
    include: {
      user: { select: { publicId: true, email: true, firstName: true, lastName: true } },
      returnRequest: { select: { publicId: true, returnNumber: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });

  const header = [
    'id',
    'customerName',
    'customerEmail',
    'returnNumber',
    'returnExperienceRating',
    'storeCreditExperienceRating',
    'overallPlatformRating',
    'feedback',
    'submittedAt',
  ];
  const data = rows.map((row) => [
    row.publicId,
    displayName(row.user),
    row.user?.email,
    row.returnRequest?.returnNumber,
    row.returnExperienceRating,
    row.storeCreditExperienceRating,
    row.overallPlatformRating,
    row.feedback,
    row.createdAt?.toISOString?.() || row.createdAt,
  ]);
  return rowsToCsv(header, data);
}
