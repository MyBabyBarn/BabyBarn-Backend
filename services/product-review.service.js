import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { writeAdminAudit } from './audit.service.js';

const LIVE = { status: 'APPROVED', deletedAt: null };
const MAX_IMAGES = 5;
const MAX_BODY = 4000;

function emptyBreakdown() {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

function actorOf(user) {
  return {
    actorId: user?.id ?? user?.publicId ?? null,
    actorEmail: user?.email ?? null,
  };
}

async function staffUserId(user) {
  const publicId = user?.id || user?.publicId;
  if (!publicId) return null;
  const row = await prisma.user.findUnique({ where: { publicId: String(publicId) }, select: { id: true } });
  return row?.id ?? null;
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

function displayName(user) {
  const parts = [user.firstName, user.lastName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  if (user.email) {
    const local = String(user.email).split('@')[0];
    return local || 'Customer';
  }
  return 'Customer';
}

function clampRating(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new AppError(400, 'Rating must be an integer from 1 to 5');
  }
  return n;
}

function normalizeImages(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new AppError(400, 'imageUrls must be an array');
  const urls = raw.map((u) => String(u || '').trim()).filter(Boolean);
  if (urls.length > MAX_IMAGES) throw new AppError(400, `At most ${MAX_IMAGES} images allowed`);
  return urls;
}

function normalizeBody(raw) {
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  if (text.length > MAX_BODY) throw new AppError(400, `Review text must be at most ${MAX_BODY} characters`);
  return text || null;
}

function toPublicReview(row) {
  return {
    id: row.publicId,
    rating: row.rating,
    body: row.body,
    imageUrls: Array.isArray(row.imageUrls) ? row.imageUrls : [],
    reviewerName: row.reviewerDisplayName || 'Customer',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toOwnerReview(row) {
  return {
    ...toPublicReview(row),
    status: row.status,
    productId: row.product?.publicId ?? undefined,
    orderId: row.order?.publicId ?? undefined,
  };
}

const HIDE_REASONS = new Set([
  'Not about the product',
  'Personal details',
  'Offensive language',
  'Advertising or link',
  'Other',
]);

function titleFromBody(body) {
  const text = String(body || '').trim();
  if (!text) return 'Review';
  const first = text.split(/\r?\n/)[0].trim();
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

function bodyHasLink(body) {
  return /https?:\/\/|www\./i.test(String(body || ''));
}

function variantLabel(combination) {
  if (!combination || typeof combination !== 'object') return null;
  const parts = Object.values(combination)
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function needsLookFlags(row) {
  const flags = [];
  if (row.rating <= 2) flags.push('Low rating');
  if (bodyHasLink(row.body)) flags.push('Contains a link');
  return flags;
}

function toAdminReview(row) {
  const flags = needsLookFlags(row);
  const age =
    variantLabel(row.orderItem?.productVariant?.combination) ||
    (Array.isArray(row.product?.ageGroups) && row.product.ageGroups.length
      ? row.product.ageGroups.join(', ')
      : null);
  return {
    id: row.publicId,
    rating: row.rating,
    title: titleFromBody(row.body),
    body: row.body,
    imageUrls: Array.isArray(row.imageUrls) ? row.imageUrls : [],
    status: row.status,
    statusLabel: row.status === 'REJECTED' ? 'Hidden' : 'Published',
    hideReason: row.hideReason || null,
    needsLook: row.status === 'APPROVED' && flags.length > 0,
    lookFlags: flags,
    reviewerName: row.reviewerDisplayName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    product: row.product
      ? {
          id: row.product.publicId,
          name: row.product.name,
          slug: row.product.slug,
          imageUrl: row.product.imageUrl ?? null,
        }
      : null,
    productSize: age,
    customer: row.user
      ? {
          id: row.user.publicId,
          email: row.user.email,
          name: displayName(row.user),
        }
      : null,
    order: row.order
      ? { id: row.order.publicId, orderNumber: row.order.orderNumber }
      : null,
  };
}

export async function recomputeProductRating(productId) {
  const rows = await prisma.productReview.groupBy({
    by: ['rating'],
    where: { productId, ...LIVE },
    _count: { _all: true },
  });
  const breakdown = emptyBreakdown();
  let total = 0;
  let sum = 0;
  for (const row of rows) {
    const star = row.rating;
    const count = row._count._all;
    if (star >= 1 && star <= 5) {
      breakdown[star] = count;
      total += count;
      sum += star * count;
    }
  }
  const averageRating = total ? Math.round((sum / total) * 10) / 10 : null;
  await prisma.product.update({
    where: { id: productId },
    data: {
      averageRating,
      reviewCount: total,
      ratingBreakdown: breakdown,
    },
  });
  return { averageRating, reviewCount: total, ratingBreakdown: breakdown };
}

async function resolveProduct(identifier) {
  const raw = String(identifier ?? '').trim();
  if (!raw) throw new AppError(404, 'Product not found');
  let product = await prisma.product.findUnique({ where: { slug: raw } });
  if (!product) product = await prisma.product.findUnique({ where: { publicId: raw } });
  if (!product || product.isDraft || !product.isActiveListing) {
    throw new AppError(404, 'Product not found');
  }
  return product;
}

function purchaseWhere(userId, productId) {
  return {
    productId,
    cancelledAt: null,
    order: {
      userId,
      paymentStatus: 'PAID',
      status: { not: 'CANCELLED' },
      OR: [{ status: 'DELIVERED' }, { fulfillmentStatus: 'DELIVERED' }, { deliveredAt: { not: null } }],
    },
  };
}

async function findEligiblePurchase(userId, productId) {
  return prisma.orderItem.findFirst({
    where: purchaseWhere(userId, productId),
    orderBy: { createdAt: 'desc' },
    include: { order: { select: { id: true, publicId: true, orderNumber: true } } },
  });
}

export async function listProductReviewsPublic(identifier, { page = 1, limit = 10 } = {}) {
  const product = await resolveProduct(identifier);
  const take = Math.min(50, Math.max(1, Number(limit) || 10));
  const currentPage = Math.max(1, Number(page) || 1);
  const where = { productId: product.id, ...LIVE };
  const [items, total] = await Promise.all([
    prisma.productReview.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (currentPage - 1) * take,
      take,
    }),
    prisma.productReview.count({ where }),
  ]);
  const breakdown = product.ratingBreakdown && typeof product.ratingBreakdown === 'object'
    ? product.ratingBreakdown
    : emptyBreakdown();
  return {
    summary: {
      averageRating: product.averageRating,
      reviewCount: product.reviewCount || 0,
      ratingBreakdown: breakdown,
    },
    items: items.map(toPublicReview),
    pagination: {
      page: currentPage,
      limit: take,
      total,
      pages: Math.ceil(total / take) || 1,
    },
  };
}

export async function getProductReviewEligibility(user, identifier) {
  const product = await resolveProduct(identifier);
  const me = await customerUserId(user);
  const purchase = await findEligiblePurchase(me.id, product.id);
  const existing = await prisma.productReview.findFirst({
    where: { userId: me.id, productId: product.id, deletedAt: null },
  });
  return {
    canReview: Boolean(purchase) && (!existing || existing.status === 'REJECTED'),
    canEdit: Boolean(existing && existing.status === 'APPROVED' && !existing.deletedAt),
    hasPurchased: Boolean(purchase),
    existingReview: existing ? toOwnerReview(existing) : null,
  };
}

export async function createProductReview(user, body) {
  const me = await customerUserId(user);
  const productIdRaw = body?.productId;
  if (!productIdRaw) throw new AppError(400, 'productId is required');
  const product = await resolveProduct(productIdRaw);
  const purchase = await findEligiblePurchase(me.id, product.id);
  if (!purchase) {
    throw new AppError(403, 'Only customers who purchased this product can leave a review');
  }
  const rating = clampRating(body.rating);
  const reviewBody = normalizeBody(body.body);
  const imageUrls = normalizeImages(body.imageUrls);
  const name = body.reviewerDisplayName?.trim() || displayName(me);

  const existing = await prisma.productReview.findUnique({
    where: { userId_productId: { userId: me.id, productId: product.id } },
  });
  if (existing && !existing.deletedAt && existing.status === 'APPROVED') {
    throw new AppError(409, 'You already reviewed this product. Edit your existing review instead.');
  }

  let row;
  if (existing) {
    row = await prisma.productReview.update({
      where: { id: existing.id },
      data: {
        rating,
        body: reviewBody,
        imageUrls,
        status: 'APPROVED',
        deletedAt: null,
        reviewerDisplayName: name,
        orderId: purchase.orderId,
        orderItemId: purchase.id,
      },
    });
  } else {
    row = await prisma.productReview.create({
      data: {
        productId: product.id,
        userId: me.id,
        orderId: purchase.orderId,
        orderItemId: purchase.id,
        rating,
        body: reviewBody,
        imageUrls,
        status: 'APPROVED',
        reviewerDisplayName: name,
      },
    });
  }
  await recomputeProductRating(product.id);
  return toOwnerReview(row);
}

export async function updateProductReview(user, publicId, body) {
  const me = await customerUserId(user);
  const existing = await prisma.productReview.findFirst({
    where: { publicId: String(publicId), userId: me.id, deletedAt: null },
  });
  if (!existing) throw new AppError(404, 'Review not found');
  if (existing.status === 'REJECTED') {
    throw new AppError(403, 'This review was rejected. Contact support if you need help.');
  }
  const data = {};
  if (body.rating != null) data.rating = clampRating(body.rating);
  if (body.body !== undefined) data.body = normalizeBody(body.body);
  if (body.imageUrls !== undefined) data.imageUrls = normalizeImages(body.imageUrls);
  if (body.reviewerDisplayName !== undefined) {
    data.reviewerDisplayName = String(body.reviewerDisplayName || '').trim() || displayName(me);
  }
  data.status = 'APPROVED';
  const row = await prisma.productReview.update({ where: { id: existing.id }, data });
  await recomputeProductRating(existing.productId);
  return toOwnerReview(row);
}

export async function deleteOwnProductReview(user, publicId) {
  const me = await customerUserId(user);
  const existing = await prisma.productReview.findFirst({
    where: { publicId: String(publicId), userId: me.id, deletedAt: null },
  });
  if (!existing) throw new AppError(404, 'Review not found');
  await prisma.productReview.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
  });
  await recomputeProductRating(existing.productId);
  return { id: existing.publicId, deleted: true };
}

const adminInclude = {
  product: { select: { publicId: true, name: true, slug: true, imageUrl: true, ageGroups: true } },
  user: { select: { publicId: true, email: true, firstName: true, lastName: true } },
  order: { select: { publicId: true, orderNumber: true } },
  orderItem: {
    select: {
      productVariant: { select: { combination: true } },
    },
  },
};

export async function getAdminProductReview(publicId) {
  const row = await prisma.productReview.findFirst({
    where: { publicId: String(publicId), deletedAt: null },
    include: adminInclude,
  });
  if (!row) throw new AppError(404, 'Review not found');
  return toAdminReview(row);
}

function parseStatusFilter(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'all') return null;
  if (v === 'approved' || v === 'published' || v === 'pub') return 'APPROVED';
  if (v === 'rejected' || v === 'hidden' || v === 'hid') return 'REJECTED';
  if (raw === 'APPROVED' || raw === 'REJECTED') return raw;
  return null;
}

function parseRatingFilter(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'all') return null;
  if (v === 'low') return 'low';
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  return null;
}

export async function listAdminProductReviews({
  search,
  status,
  rating,
  quick,
  page = 1,
  limit = 20,
} = {}) {
  const take = Math.min(100, Math.max(1, Number(limit) || 20));
  const currentPage = Math.max(1, Number(page) || 1);
  const where = { deletedAt: null };
  const statusFilter = parseStatusFilter(status);
  const qk = String(quick || '').toLowerCase();
  if (qk === 'pub' || qk === 'published') where.status = 'APPROVED';
  else if (qk === 'hid' || qk === 'hidden') where.status = 'REJECTED';
  else if (qk === 'need' || qk === 'needs') {
    where.status = 'APPROVED';
    where.rating = { lte: 2 };
  } else if (statusFilter) {
    where.status = statusFilter;
  }

  const rate = parseRatingFilter(rating);
  if (rate === 'low') where.rating = { ...(where.rating || {}), lte: 2 };
  else if (typeof rate === 'number') where.rating = rate;

  if (search && String(search).trim()) {
    const q = String(search).trim();
    where.OR = [
      { body: { contains: q, mode: 'insensitive' } },
      { reviewerDisplayName: { contains: q, mode: 'insensitive' } },
      { product: { name: { contains: q, mode: 'insensitive' } } },
      { user: { email: { contains: q, mode: 'insensitive' } } },
      { user: { firstName: { contains: q, mode: 'insensitive' } } },
      { user: { lastName: { contains: q, mode: 'insensitive' } } },
      { order: { orderNumber: { contains: q, mode: 'insensitive' } } },
      { publicId: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [rows, total, publishedCount, hiddenCount, needCount, ratingGroups, allCount, platformCount] =
    await Promise.all([
      prisma.productReview.findMany({
        where,
        include: adminInclude,
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * take,
        take,
      }),
      prisma.productReview.count({ where }),
      prisma.productReview.count({ where: { deletedAt: null, status: 'APPROVED' } }),
      prisma.productReview.count({ where: { deletedAt: null, status: 'REJECTED' } }),
      prisma.productReview.count({
        where: { deletedAt: null, status: 'APPROVED', rating: { lte: 2 } },
      }),
      prisma.productReview.groupBy({
        by: ['rating'],
        where: { deletedAt: null, status: 'APPROVED' },
        _count: { _all: true },
      }),
      prisma.productReview.count({ where: { deletedAt: null } }),
      prisma.platformReview.count(),
    ]);

  const breakdown = emptyBreakdown();
  let sum = 0;
  let published = 0;
  for (const g of ratingGroups) {
    const star = g.rating;
    const count = g._count._all;
    if (star >= 1 && star <= 5) {
      breakdown[star] = count;
      published += count;
      sum += star * count;
    }
  }

  return {
    items: rows.map(toAdminReview),
    pagination: { page: currentPage, limit: take, total, pages: Math.ceil(total / take) || 1 },
    summary: {
      publishedCount: published,
      averageRating: published ? Math.round((sum / published) * 10) / 10 : null,
      breakdown,
    },
    quickCounts: {
      need: needCount,
      pub: publishedCount,
      hid: hiddenCount,
    },
    tabCounts: {
      prod: allCount,
      plat: platformCount,
    },
  };
}

export async function rejectProductReview(user, publicId, { reason } = {}) {
  const why = String(reason || '').trim();
  if (!why || !HIDE_REASONS.has(why)) {
    throw new AppError(400, 'Choose a valid hide reason.', 'REVIEW_HIDE_REASON_REQUIRED');
  }
  const existing = await prisma.productReview.findFirst({
    where: { publicId: String(publicId), deletedAt: null },
  });
  if (!existing) throw new AppError(404, 'Review not found');
  if (existing.status === 'REJECTED') {
    return getAdminProductReview(existing.publicId);
  }
  const row = await prisma.productReview.update({
    where: { id: existing.id },
    data: { status: 'REJECTED', hideReason: why },
    include: adminInclude,
  });
  await recomputeProductRating(existing.productId);
  await writeAdminAudit({
    ...actorOf(user),
    action: 'PRODUCT_REVIEW_REJECTED',
    entityType: 'ProductReview',
    entityId: row.publicId,
    meta: { productId: row.product?.publicId, rating: row.rating, reason: why },
  });
  return toAdminReview(row);
}

export async function restoreProductReview(user, publicId) {
  const existing = await prisma.productReview.findFirst({
    where: { publicId: String(publicId), deletedAt: null },
  });
  if (!existing) throw new AppError(404, 'Review not found');
  if (existing.status === 'APPROVED') {
    return getAdminProductReview(existing.publicId);
  }
  const row = await prisma.productReview.update({
    where: { id: existing.id },
    data: { status: 'APPROVED', hideReason: null },
    include: adminInclude,
  });
  await recomputeProductRating(existing.productId);
  await writeAdminAudit({
    ...actorOf(user),
    action: 'PRODUCT_REVIEW_RESTORED',
    entityType: 'ProductReview',
    entityId: row.publicId,
    meta: { productId: row.product?.publicId, rating: row.rating },
  });
  return toAdminReview(row);
}

export async function bulkHideProductReviews(user, ids, reason) {
  const list = Array.isArray(ids) ? ids.map((id) => String(id)).filter(Boolean) : [];
  if (!list.length) throw new AppError(400, 'Select at least one review.');
  const out = [];
  for (const id of list) {
    out.push(await rejectProductReview(user, id, { reason }));
  }
  return { items: out, count: out.length };
}

export async function bulkRestoreProductReviews(user, ids) {
  const list = Array.isArray(ids) ? ids.map((id) => String(id)).filter(Boolean) : [];
  if (!list.length) throw new AppError(400, 'Select at least one review.');
  const out = [];
  for (const id of list) {
    out.push(await restoreProductReview(user, id));
  }
  return { items: out, count: out.length };
}

export async function removeProductReviewAdmin(user, publicId) {
  const existing = await prisma.productReview.findFirst({
    where: { publicId: String(publicId), deletedAt: null },
  });
  if (!existing) throw new AppError(404, 'Review not found');
  const row = await prisma.productReview.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
    include: adminInclude,
  });
  await recomputeProductRating(existing.productId);
  await writeAdminAudit({
    ...actorOf(user),
    action: 'PRODUCT_REVIEW_REMOVED',
    entityType: 'ProductReview',
    entityId: row.publicId,
    meta: { productId: row.product?.publicId, rating: row.rating, by: await staffUserId(user) },
  });
  return toAdminReview(row);
}

export { HIDE_REASONS };
