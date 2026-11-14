import { prisma } from './prisma.js';

/**
 * Single source of truth for admin category product badges / KPIs.
 * Counts via ProductCategory join (not only denormalized Product.categoryId).
 *
 * @param {object} opts
 * @param {number[]} [opts.categoryIds] Internal category ids. Empty → all categories with joins.
 * @param {boolean} [opts.includeDescendants] When true with a single root, expand to subtree ids first.
 * @param {Map<number, number[]>} [opts.descendantIdsByRoot] Optional precomputed map rootId → [self,...descendants]
 * @param {('NEW'|'REFURBISHED')[]} [opts.productTypes]
 * @param {object} [opts.listingStates] { includeDeleted?: boolean, isDraft?: boolean|null, isActiveListing?: boolean|null }
 * @returns {Promise<Map<number, number>>} categoryId → distinct product count
 */
export async function getCategoryProductCounts({
  categoryIds,
  includeDescendants = false,
  descendantIdsByRoot,
  productTypes,
  listingStates = {},
} = {}) {
  let ids = Array.isArray(categoryIds) ? [...categoryIds] : [];

  if (includeDescendants && ids.length === 1 && descendantIdsByRoot?.has(ids[0])) {
    ids = descendantIdsByRoot.get(ids[0]);
  } else if (includeDescendants && ids.length === 1) {
    ids = await collectDescendantCategoryIds(ids[0]);
  }

  const productWhere = {};
  if (!listingStates.includeDeleted) {
    productWhere.deletedAt = null;
  }
  if (listingStates.isDraft === true || listingStates.isDraft === false) {
    productWhere.isDraft = listingStates.isDraft;
  }
  if (listingStates.isActiveListing === true || listingStates.isActiveListing === false) {
    productWhere.isActiveListing = listingStates.isActiveListing;
  }
  if (Array.isArray(productTypes) && productTypes.length > 0) {
    productWhere.productType = productTypes.length === 1 ? productTypes[0] : { in: productTypes };
  }

  const rows = await prisma.productCategory.groupBy({
    by: ['categoryId'],
    where: {
      ...(ids.length ? { categoryId: { in: ids } } : {}),
      product: productWhere,
    },
    _count: { _all: true },
  });

  const map = new Map();
  for (const row of rows) {
    map.set(row.categoryId, row._count._all);
  }
  if (ids.length) {
    for (const id of ids) {
      if (!map.has(id)) map.set(id, 0);
    }
  }
  return map;
}

/** Sum counts for a root + all descendants using a direct-count map. */
export function sumDeepCount(rootId, childrenByParent, directCounts) {
  let total = directCounts.get(rootId) ?? 0;
  const kids = childrenByParent.get(rootId) ?? [];
  for (const kidId of kids) {
    total += sumDeepCount(kidId, childrenByParent, directCounts);
  }
  return total;
}

async function collectDescendantCategoryIds(rootId) {
  const rows = await prisma.category.findMany({
    select: { id: true, parentId: true },
  });
  const byParent = new Map();
  for (const r of rows) {
    const key = r.parentId == null ? null : r.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r.id);
  }
  const out = [];
  const walk = (id) => {
    out.push(id);
    for (const child of byParent.get(id) ?? []) walk(child);
  };
  walk(rootId);
  return out;
}

/**
 * Attach `_count.products` (direct, join-based, non-deleted) onto flat category rows.
 * @param {Array<{ id: number }>} rows
 */
export async function attachDirectProductCounts(rows) {
  if (!rows.length) return rows;
  const counts = await getCategoryProductCounts({
    categoryIds: rows.map((r) => r.id),
  });
  return rows.map((row) => ({
    ...row,
    _count: {
      ...(row._count || {}),
      products: counts.get(row.id) ?? 0,
    },
  }));
}
