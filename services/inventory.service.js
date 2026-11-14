import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { productAvailableStock, variantAvailableStock } from './inventory-reservation.js';
import { writeInventoryLedger } from './inventory-ledger.service.js';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  assertSellableStock,
  isSellableAvailable,
  lowStockThresholdFromPar,
  stockStatusFromAvailable,
} from '../lib/inventory-stock-rules.js';
import { notifyLowStock } from './admin-notification.service.js';

export const LOW_STOCK_THRESHOLD = DEFAULT_LOW_STOCK_THRESHOLD;

export function computeTotalStock(product) {
  const variants = product.variants ?? [];
  if (variants.length > 0) {
    return variants.reduce((s, v) => s + v.stock, 0);
  }
  return product.stock;
}

export function computeAvailableStock(product) {
  return productAvailableStock(product);
}

/** Validates aggregate available stock without mutating (for unpaid checkout orders). */
export function assertStockAvailable(product, quantity) {
  assertSellableStock(product, quantity);
}

export function stockStatusFromTotal(total, reorderPoint, productType = 'NEW') {
  return stockStatusFromAvailable(total, reorderPoint, productType);
}

export function combinationLabel(combination) {
  if (!combination || typeof combination !== 'object') return '—';
  const entries = Object.entries(combination);
  if (entries.length === 0) return '—';
  return entries.map(([k, val]) => `${k}: ${String(val)}`).join(' · ');
}

export async function syncParentStockFromVariants(tx, productId) {
  const sum = await tx.productVariant.aggregate({
    where: { productId },
    _sum: { stock: true },
  });
  await tx.product.update({
    where: { id: productId },
    data: { stock: sum._sum.stock ?? 0 },
  });
}

/**
 * Manual inventory adjustment: one variant SKU or simple product stock only.
 */
async function adjustManualStock(tx, product, userId, { variantPublicId, delta, reason }) {
  const variants = await tx.productVariant.findMany({
    where: { productId: product.id },
    orderBy: { sortOrder: 'asc' },
  });

  if (variants.length === 0) {
    if (variantPublicId) {
      throw new AppError(400, 'This product has no variants');
    }
    if (product.stock + delta < 0) {
      throw new AppError(400, 'Stock cannot go below 0');
    }
    const next = Math.max(0, product.stock + delta);
    const applied = next - product.stock;
    await tx.product.update({
      where: { id: product.id },
      data: { stock: next },
    });
    await tx.inventoryAdjustment.create({
      data: {
        productId: product.id,
        userId,
        quantityChange: applied,
        reason: reason?.trim() || null,
        productVariantId: null,
      },
    });
    await writeInventoryLedger(tx, {
      productId: product.id,
      productVariantId: null,
      quantityDelta: applied,
      eventType: 'ADJUST',
      referenceType: 'inventory_adjustment',
      referenceId: product.publicId,
      actorUserId: userId,
      note: reason?.trim() || null,
    });
    return { applied, variantPublicId: null, variantDbId: null };
  }

  if (!variantPublicId) {
    throw new AppError(
      400,
      'This product has variants — open a variant row and adjust stock for that SKU.'
    );
  }

  const v = variants.find((x) => x.publicId === variantPublicId);
  if (!v) {
    throw new AppError(404, 'Variant not found');
  }
  if (v.stock + delta < 0) {
    throw new AppError(400, 'Stock cannot go below 0');
  }
  const next = Math.max(0, v.stock + delta);
  const applied = next - v.stock;
  await tx.productVariant.update({
    where: { id: v.id },
    data: { stock: next },
  });
  await syncParentStockFromVariants(tx, product.id);

  await tx.inventoryAdjustment.create({
    data: {
      productId: product.id,
      userId,
      quantityChange: applied,
      reason: reason?.trim() || null,
      productVariantId: v.id,
    },
  });
  await writeInventoryLedger(tx, {
    productId: product.id,
    productVariantId: v.id,
    quantityDelta: applied,
    eventType: 'ADJUST',
    referenceType: 'inventory_adjustment',
    referenceId: `${product.publicId}:${v.publicId}`,
    actorUserId: userId,
    note: reason?.trim() || null,
  });

  return { applied, variantPublicId: v.publicId, variantDbId: v.id };
}

/**
 * Order checkout: take quantity from aggregate (variants first in sort order, then parent for simple).
 */
export async function decrementOrderStockFromProduct(tx, product, quantity) {
  const variants = await tx.productVariant.findMany({
    where: { productId: product.id },
    orderBy: { sortOrder: 'asc' },
  });

  if (variants.length === 0) {
    const next = product.stock - quantity;
    if (next < 0) {
      throw new AppError(400, `Insufficient stock for "${product.name}"`);
    }
    await tx.product.update({
      where: { id: product.id },
      data: { stock: next },
    });
    return;
  }

  let remaining = quantity;
  const fresh = await tx.productVariant.findMany({
    where: { productId: product.id },
    orderBy: { sortOrder: 'asc' },
  });
  for (const v of fresh) {
    if (remaining <= 0) break;
    const take = Math.min(v.stock, remaining);
    if (take > 0) {
      await tx.productVariant.update({
        where: { id: v.id },
        data: { stock: v.stock - take },
      });
    }
    remaining -= take;
  }
  if (remaining > 0) {
    throw new AppError(400, `Insufficient stock for "${product.name}"`);
  }
  await syncParentStockFromVariants(tx, product.id);
}

function flattenProductToSkuLines(p) {
  const category = p.category
    ? { id: p.category.publicId, name: p.category.name, slug: p.category.slug }
    : null;

  const variants = p.variants ?? [];
  if (variants.length > 0) {
    return variants.map((v) => {
      const totalStock = v.stock;
      const reservedStock = v.reservedStock ?? 0;
      const availableStock = variantAvailableStock(v);
      const stockStatus = stockStatusFromAvailable(availableStock, p.reorderPoint, p.productType);
      const price =
        v.memberPriceOverride ?? v.priceOverride ?? p.memberPrice ?? p.unitPriceAmount ?? null;
      return {
        lineKey: `${p.publicId}:${v.publicId}`,
        productId: p.publicId,
        variantId: v.publicId,
        name: p.name,
        variantLabel: combinationLabel(v.combination),
        sku: v.sku,
        barcodeCode: (p.barcodes || []).find((b) => b.productVariantId === v.id)?.code ?? null,
        imageUrl: v.imageUrl || p.imageUrl || null,
        category,
        productType: p.productType,
        isActiveListing: p.isActiveListing !== false,
        warehouseLocation: v.warehouseLocation || p.warehouseLocation || null,
        price,
        reorderPoint: p.reorderPoint ?? null,
        lowStockThreshold: lowStockThresholdFromPar(p.reorderPoint),
        sourceProduct: p.sourceProduct
          ? { id: p.sourceProduct.publicId, name: p.sourceProduct.name, sku: p.sourceProduct.sku }
          : null,
        inventoryModel: p.inventoryModel,
        totalStock,
        reservedStock,
        availableStock,
        stockStatus,
        updatedAt: v.updatedAt,
      };
    });
  }

  const totalStock = p.stock;
  const reservedStock = p.reservedStock ?? 0;
  const availableStock = productAvailableStock(p);
  const stockStatus = stockStatusFromAvailable(availableStock, p.reorderPoint, p.productType);
  const price = p.memberPrice ?? p.unitPriceAmount ?? null;
  return [
    {
      lineKey: `${p.publicId}:simple`,
      productId: p.publicId,
      variantId: null,
      name: p.name,
      variantLabel: '—',
      sku: p.sku,
      barcodeCode: (p.barcodes || []).find((b) => b.productVariantId == null)?.code ?? null,
      imageUrl: p.imageUrl || null,
      category,
      productType: p.productType,
      isActiveListing: p.isActiveListing !== false,
      warehouseLocation: p.warehouseLocation || null,
      price,
      reorderPoint: p.reorderPoint ?? null,
      lowStockThreshold: lowStockThresholdFromPar(p.reorderPoint),
      sourceProduct: p.sourceProduct
        ? { id: p.sourceProduct.publicId, name: p.sourceProduct.name, sku: p.sourceProduct.sku }
        : null,
      inventoryModel: p.inventoryModel,
      totalStock,
      reservedStock,
      availableStock,
      stockStatus,
      updatedAt: p.updatedAt,
    },
  ];
}

function productTypeWhere(productType) {
  if (productType === 'NEW' || productType === 'REFURBISHED') {
    return { productType };
  }
  // ALL / all / omitted — include both NEW and REFURBISHED
  return {};
}

const LIST_PRODUCT_INCLUDE = {
  category: true,
  variants: { orderBy: { sortOrder: 'asc' } },
  sourceProduct: { select: { publicId: true, name: true, sku: true } },
  barcodes: { select: { code: true, productVariantId: true } },
};

function buildListProductWhere({
  search,
  productTypeFilter,
  categoryId,
}) {
  const where = {
    isDraft: false,
    ...productTypeWhere(
      productTypeFilter &&
        productTypeFilter !== 'all' &&
        String(productTypeFilter).toUpperCase() !== 'ALL'
        ? productTypeFilter
        : undefined
    ),
  };

  if (search && String(search).trim()) {
    const q = String(search).trim();
    where.AND = where.AND ?? [];
    where.AND.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
        { variants: { some: { sku: { contains: q, mode: 'insensitive' } } } },
        { barcodes: { some: { code: { contains: q, mode: 'insensitive' } } } },
        {
          barcodes: {
            some: { aliases: { some: { code: { contains: q, mode: 'insensitive' } } } },
          },
        },
      ],
    });
  }

  if (categoryId && String(categoryId).trim() && String(categoryId) !== 'all') {
    where.category = { publicId: String(categoryId).trim() };
  }

  return where;
}

function lineFilterParams({ stockStatus: stockStatusFilter, location, priceMin, priceMax }) {
  const locQ =
    location && String(location).trim() && String(location) !== 'all' ? String(location).trim() : '';
  const minP =
    priceMin !== undefined && priceMin !== '' && !Number.isNaN(Number(priceMin)) ? Number(priceMin) : null;
  const maxP =
    priceMax !== undefined && priceMax !== '' && !Number.isNaN(Number(priceMax)) ? Number(priceMax) : null;
  return { stockStatusFilter, locQ, minP, maxP };
}

function inventoryLineMatchesFilters(line, { stockStatusFilter, locQ, minP, maxP }) {
  if (locQ && String(line.warehouseLocation || '') !== locQ) return false;
  if (minP != null && (line.price == null || Number(line.price) < minP)) return false;
  if (maxP != null && (line.price == null || Number(line.price) > maxP)) return false;
  if (!stockStatusFilter || stockStatusFilter === 'all') return true;
  if (stockStatusFilter === 'inactive') return line.isActiveListing === false;
  if (stockStatusFilter === 'low_stock' || stockStatusFilter === 'lowall') {
    return line.isActiveListing !== false && line.stockStatus === 'low_stock';
  }
  if (stockStatusFilter === 'out_of_stock' || stockStatusFilter === 'out') {
    return line.isActiveListing !== false && line.stockStatus === 'out_of_stock';
  }
  if (stockStatusFilter === 'in_stock' || stockStatusFilter === 'ok') {
    return line.isActiveListing !== false && line.stockStatus === 'in_stock';
  }
  return line.stockStatus === stockStatusFilter;
}

function sortInventoryLines(lines, sortKey) {
  const key = String(sortKey || 'name');
  lines.sort((a, b) => {
    if (key === 'sku') return String(a.sku).localeCompare(String(b.sku));
    if (key === 'low') return (a.totalStock || 0) - (b.totalStock || 0);
    if (key === 'high') return (b.totalStock || 0) - (a.totalStock || 0);
    if (key === 'price') return (Number(b.price) || 0) - (Number(a.price) || 0);
    return String(a.name).localeCompare(String(b.name));
  });
}

const PRODUCT_LIST_BATCH = 80;

/** Batched product reads → flattened, line-filtered SKU rows (bounded memory). */
async function collectFilteredInventoryLines(productWhere, lineFilters) {
  let productSkip = 0;
  const filtered = [];
  while (true) {
    const rows = await prisma.product.findMany({
      where: productWhere,
      include: LIST_PRODUCT_INCLUDE,
      orderBy: { updatedAt: 'desc' },
      skip: productSkip,
      take: PRODUCT_LIST_BATCH,
    });
    if (!rows.length) break;
    productSkip += rows.length;
    const flat = rows.flatMap((p) => flattenProductToSkuLines(p));
    for (const line of flat) {
      if (inventoryLineMatchesFilters(line, lineFilters)) filtered.push(line);
    }
  }
  return filtered;
}

async function countSkuLinesForProductWhere(productWhere) {
  const [variantLines, simpleLines] = await Promise.all([
    prisma.productVariant.count({ where: { product: productWhere } }),
    prisma.product.count({
      where: {
        ...productWhere,
        variants: { none: {} },
      },
    }),
  ]);
  return variantLines + simpleLines;
}

/** @typedef {{ productPublicId: string; variantPublicId: string | null }} SkuLinePair */

/**
 * @param {object} productWhere
 * @param {number} skip
 * @param {number} take
 * @returns {Promise<SkuLinePair[]>}
 */
async function fetchSkuLinePairsPage(productWhere, skip, take) {
  const ids = await prisma.product.findMany({
    where: productWhere,
    select: { id: true },
  });
  if (!ids.length) return [];
  const productIds = ids.map((p) => p.id);

  const rows = await prisma.$queryRaw`
    WITH lines AS (
      SELECT
        p."publicId" AS product_public_id,
        v."publicId" AS variant_public_id,
        p.name AS sort_name,
        v."sortOrder" AS variant_sort,
        1 AS kind
      FROM "ProductVariant" v
      INNER JOIN "Product" p ON p.id = v."productId"
      WHERE p.id = ANY(${productIds}::int[])
      UNION ALL
      SELECT
        p."publicId",
        NULL::text,
        p.name,
        0,
        0
      FROM "Product" p
      WHERE p.id = ANY(${productIds}::int[])
        AND NOT EXISTS (SELECT 1 FROM "ProductVariant" pv WHERE pv."productId" = p.id)
    )
    SELECT product_public_id, variant_public_id
    FROM lines
    ORDER BY sort_name ASC, kind ASC, variant_sort ASC
    OFFSET ${skip}
    LIMIT ${take}
  `;

  return rows.map((r) => ({
    productPublicId: r.product_public_id,
    variantPublicId: r.variant_public_id ?? null,
  }));
}

/**
 * @param {SkuLinePair[]} pairs
 */
async function hydrateSkuLinePairs(pairs) {
  const productPublicIds = [...new Set(pairs.map((p) => p.productPublicId))];
  const products = await prisma.product.findMany({
    where: { publicId: { in: productPublicIds } },
    include: LIST_PRODUCT_INCLUDE,
  });
  const byPublicId = new Map(products.map((p) => [p.publicId, p]));
  const linesByKey = new Map();
  for (const product of products) {
    for (const line of flattenProductToSkuLines(product)) {
      linesByKey.set(line.lineKey, line);
    }
  }
  const out = [];
  for (const pair of pairs) {
    const product = byPublicId.get(pair.productPublicId);
    if (!product) continue;
    const key = pair.variantPublicId
      ? `${pair.productPublicId}:${pair.variantPublicId}`
      : `${pair.productPublicId}:simple`;
    const line = linesByKey.get(key);
    if (line) out.push(line);
  }
  return out;
}

function overviewActivityDateFilter(from, to) {
  /** @type {{ gte?: Date; lte?: Date }} */
  const createdAt = {};
  if (from) {
    const d = new Date(`${from}T00:00:00`);
    if (!Number.isNaN(d.getTime())) createdAt.gte = d;
  }
  if (to) {
    const d = new Date(`${to}T23:59:59.999`);
    if (!Number.isNaN(d.getTime())) createdAt.lte = d;
  }
  return Object.keys(createdAt).length ? createdAt : null;
}

/**
 * Batch overview KPIs (same shape as getProductOverview.kpis) for many products.
 * @param {string[]} productPublicIds
 */
async function batchProductOverviewKpis(productPublicIds, { from = null, to = null } = {}) {
  if (!productPublicIds.length) return new Map();

  const products = await prisma.product.findMany({
    where: { publicId: { in: productPublicIds } },
    include: { variants: { orderBy: { sortOrder: 'asc' } } },
  });
  const dbIds = products.map((p) => p.id);

  const ledgerAgg = await prisma.inventoryLedgerEvent.groupBy({
    by: ['productId', 'eventType'],
    where: { productId: { in: dbIds } },
    _sum: { quantityDelta: true },
  });

  const ledgerByProduct = new Map();
  for (const row of ledgerAgg) {
    if (!ledgerByProduct.has(row.productId)) ledgerByProduct.set(row.productId, []);
    ledgerByProduct.get(row.productId).push(row);
  }

  const activityFilter = overviewActivityDateFilter(from, to);
  const activityByProduct = new Map();
  if (activityFilter) {
    const actRows = await prisma.inventoryLedgerEvent.groupBy({
      by: ['productId'],
      where: {
        productId: { in: dbIds },
        createdAt: activityFilter,
        eventType: { notIn: ['RESERVE', 'RELEASE'] },
      },
      _count: { _all: true },
    });
    for (const row of actRows) {
      activityByProduct.set(row.productId, row._count._all);
    }
  }

  const returnRows = await prisma.returnRequest.findMany({
    where: {
      type: 'STANDARD',
      orderItem: { productId: { in: dbIds } },
    },
    select: {
      orderItem: { select: { productId: true } },
      receivedQuantity: true,
      disposition: true,
      dispositionQuantity: true,
      acceptedQuantity: true,
    },
  });

  const returnsByProduct = new Map();
  for (const rr of returnRows) {
    const pid = rr.orderItem?.productId;
    if (!pid) continue;
    if (!returnsByProduct.has(pid)) {
      returnsByProduct.set(pid, { totalReturned: 0, totalMovedToRefurb: 0, totalDiscarded: 0 });
    }
    const agg = returnsByProduct.get(pid);
    agg.totalReturned += Math.max(0, Number(rr.receivedQuantity ?? 0));
    const dispQty = Math.max(0, Number(rr.dispositionQuantity ?? rr.acceptedQuantity ?? 0));
    if (rr.disposition === 'REFURB') agg.totalMovedToRefurb += dispQty;
    if (rr.disposition === 'DISCARD') agg.totalDiscarded += dispQty;
  }

  const result = new Map();

  for (const product of products) {
    const rows = ledgerByProduct.get(product.id) || [];
    const sumByType = Object.fromEntries(
      rows.map((row) => [row.eventType, Math.abs(Number(row._sum.quantityDelta || 0))])
    );
    const signedByType = Object.fromEntries(
      rows.map((row) => [row.eventType, Number(row._sum.quantityDelta || 0)])
    );
    const totalSold = sumByType.COMMIT || 0;
    const totalRestocked = (sumByType.RESTOCK || 0) + (sumByType.REFUND_RESTORE || 0);
    const positiveAdjust = Math.max(0, signedByType.ADJUST || 0);
    const totalReceived = positiveAdjust + totalRestocked;
    const ret = returnsByProduct.get(product.id) || {
      totalReturned: 0,
      totalMovedToRefurb: 0,
      totalDiscarded: 0,
    };
    const currentAvailable = computeAvailableStock(product);

    result.set(product.publicId, {
      kpis: {
        totalInventoryReceived: totalReceived,
        totalSold,
        totalReturned: ret.totalReturned,
        totalRestocked,
        totalMovedToRefurbishment: ret.totalMovedToRefurb,
        totalDiscarded: ret.totalDiscarded,
        currentAvailableInventory: currentAvailable,
        manualAdjustments: Math.abs(Number(signedByType.ADJUST || 0)),
      },
      activityInRange: activityFilter ? activityByProduct.get(product.id) ?? 0 : null,
    });
  }

  return result;
}

export class InventoryService {
  async getStats({ productType } = {}) {
    const products = await prisma.product.findMany({
      where: { isDraft: false, ...productTypeWhere(productType) },
      include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });
    let totalSkus = 0;
    let totalUnits = 0;
    let critical = 0;
    let outOfStock = 0;
    let inactive = 0;
    const locations = new Set();
    for (const p of products) {
      const lines = flattenProductToSkuLines(p);
      for (const line of lines) {
        totalSkus += 1;
        totalUnits += Number(line.totalStock) || 0;
        if (line.isActiveListing === false) inactive += 1;
        if (line.warehouseLocation) locations.add(String(line.warehouseLocation));
        const t = line.availableStock ?? line.totalStock;
        if (t <= 0 || line.stockStatus === 'out_of_stock') outOfStock += 1;
        else if (line.stockStatus === 'low_stock') critical += 1;
      }
    }

    return {
      totalSkus,
      totalUnits,
      criticalUnderThreshold: critical,
      outOfStock,
      inactive,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      locations: [...locations].sort((a, b) => a.localeCompare(b)),
    };
  }

  async list({
    page = 1,
    limit = 24,
    search,
    stockStatus: stockStatusFilter,
    productType: productTypeFilter,
    location,
    categoryId,
    priceMin,
    priceMax,
    sort = 'name',
  }) {
    const skip = (page - 1) * limit;
    const productWhere = buildListProductWhere({ search, productTypeFilter, categoryId });
    const lineFilters = lineFilterParams({ stockStatus: stockStatusFilter, location, priceMin, priceMax });
    const sortKey = String(sort || 'name');

    const hasLineFilters =
      (stockStatusFilter && stockStatusFilter !== 'all') ||
      Boolean(lineFilters.locQ) ||
      lineFilters.minP != null ||
      lineFilters.maxP != null;

    let items;
    let total;

    if (!hasLineFilters && sortKey === 'name') {
      total = await countSkuLinesForProductWhere(productWhere);
      const pairs = await fetchSkuLinePairsPage(productWhere, skip, limit);
      items = await hydrateSkuLinePairs(pairs);
    } else {
      const filtered = await collectFilteredInventoryLines(productWhere, lineFilters);
      sortInventoryLines(filtered, sortKey);
      total = filtered.length;
      items = filtered.slice(skip, skip + limit);
    }

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Inventory overview list — one row per product with lifetime KPIs (no per-row overview N+1).
   */
  async listOverview({
    page = 1,
    limit = 24,
    search,
    stockStatus: stockStatusFilter,
    productType: productTypeFilter,
    location,
    categoryId,
    priceMin,
    priceMax,
    from = null,
    to = null,
  }) {
    const skip = (page - 1) * limit;
    const productWhere = buildListProductWhere({ search, productTypeFilter, categoryId });
    const lineFilters = lineFilterParams({ stockStatus: stockStatusFilter, location, priceMin, priceMax });

    const hasLineFilters =
      (stockStatusFilter && stockStatusFilter !== 'all') ||
      Boolean(lineFilters.locQ) ||
      lineFilters.minP != null ||
      lineFilters.maxP != null;

    let productPublicIds;
    let total;

    if (!hasLineFilters) {
      const [products, count] = await Promise.all([
        prisma.product.findMany({
          where: productWhere,
          select: { publicId: true, name: true, sku: true, productType: true },
          orderBy: { name: 'asc' },
          skip,
          take: limit,
        }),
        prisma.product.count({ where: productWhere }),
      ]);
      productPublicIds = products.map((p) => p.publicId);
      total = count;
      const summaries = await batchProductOverviewKpis(productPublicIds, { from, to });
      const items = products.map((p) => {
        const extra = summaries.get(p.publicId);
        return {
          productId: p.publicId,
          name: p.name,
          sku: p.sku,
          productType: p.productType,
          kpis: extra?.kpis ?? null,
          activityInRange: extra?.activityInRange ?? null,
        };
      });
      return {
        items,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit) || 1,
        },
      };
    }

    const filtered = await collectFilteredInventoryLines(productWhere, lineFilters);
    const byProduct = new Map();
    for (const line of filtered) {
      if (!byProduct.has(line.productId)) {
        byProduct.set(line.productId, {
          productId: line.productId,
          name: line.name,
          sku: line.sku,
          productType: line.productType,
        });
      }
    }
    const allProducts = [...byProduct.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    total = allProducts.length;
    const pageProducts = allProducts.slice(skip, skip + limit);
    productPublicIds = pageProducts.map((p) => p.productId);
    const summaries = await batchProductOverviewKpis(productPublicIds, { from, to });
    const items = pageProducts.map((p) => {
      const extra = summaries.get(p.productId);
      return {
        ...p,
        kpis: extra?.kpis ?? null,
        activityInRange: extra?.activityInRange ?? null,
      };
    });

    return {
      items,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    };
  }

  /**
   * Apply a stock delta inside an existing transaction (used by draft session confirm).
   */
  async adjustStockInTx(tx, { productPublicId, variantPublicId, delta, reason, userId }) {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new AppError(400, 'delta must be a non-zero integer');
    }
    const product = await tx.product.findUnique({
      where: { publicId: productPublicId },
      include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!product || product.isDraft) {
      throw new AppError(404, 'Product not found');
    }
    const beforeAvailable = productAvailableStock(product);
    const beforeTotal = computeTotalStock(product);
    const { applied } = await adjustManualStock(tx, product, userId, {
      variantPublicId,
      delta,
      reason,
    });
    const updated = await tx.product.findUnique({
      where: { id: product.id },
      include: { category: true, variants: { orderBy: { sortOrder: 'asc' } } },
    });
    return {
      product: updated,
      applied,
      quantityChange: applied,
      previousTotal: beforeTotal,
      newTotal: computeTotalStock(updated),
      beforeAvailable,
    };
  }

  async adjustStock({ productPublicId, variantPublicId, delta, reason, userPublicId }) {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new AppError(400, 'delta must be a non-zero integer');
    }

    const user = await prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true },
    });
    if (!user) {
      throw new AppError(401, 'User not found');
    }

    const result = await prisma.$transaction(async (tx) => {
      return this.adjustStockInTx(tx, {
        productPublicId,
        variantPublicId,
        delta,
        reason,
        userId: user.id,
      });
    });

    const available = productAvailableStock(result.product);
    const status = stockStatusFromAvailable(
      available,
      result.product.reorderPoint,
      result.product.productType
    );
    if (status === 'low_stock') {
      notifyLowStock(result.product, available);
    }

    if (
      result.product.productType === 'NEW' &&
      !isSellableAvailable(result.beforeAvailable, 'NEW') &&
      isSellableAvailable(available, 'NEW')
    ) {
      import('./stock-alert.service.js')
        .then(({ notifyProductBackInStock }) => notifyProductBackInStock(result.product.id))
        .catch((err) => console.error('[inventory] back-in-stock notify failed', err));
    }

    return result;
  }

  async updateProductType(productPublicId, productType) {
    const { isRefurbishedEnabled } = await import('../config/feature-flags.js');
    if (productType === 'REFURBISHED' && !isRefurbishedEnabled()) {
      throw new AppError(400, 'Refurbished products are temporarily disabled', 'REFURBISHED_DISABLED');
    }
    const product = await prisma.product.findUnique({ where: { publicId: productPublicId } });
    if (!product) {
      throw new AppError(404, 'Product not found');
    }
    if (product.sourceProductId != null || product.productType === 'REFURBISHED') {
      throw new AppError(
        400,
        'Cannot change product type on a pipeline refurb SKU.',
        'REFURB_LOCKED'
      );
    }
    return prisma.product.update({
      where: { id: product.id },
      data: { productType },
      include: { category: true, variants: true },
    });
  }

  async listHistory({
    page = 1,
    limit = 20,
    productPublicId = null,
    productType = null,
    search = null,
    range = 'all',
    from = null,
    to = null,
    eventType = null,
    group = 'all',
    source = null,
    location = null,
    actor = null,
    includeFacets = false,
  }) {
    const { listLedgerHistory } = await import('./inventory-ledger.service.js');
    const ledger = await listLedgerHistory({
      page,
      limit,
      productPublicId,
      productType,
      search,
      range,
      from,
      to,
      eventType,
      group,
      source,
      location,
      actor,
      includeFacets,
    });
    return {
      entries: ledger.entries.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        quantityChange: e.quantityDelta,
        stockAfter: e.stockAfter ?? null,
        location: e.location ?? null,
        source: e.source ?? null,
        reason: e.note,
        referenceType: e.referenceType,
        referenceId: e.referenceId,
        referenceOrderNumber: e.referenceOrderNumber ?? null,
        referenceCheckoutIntentId: e.referenceCheckoutIntentId ?? null,
        referenceReturnNumber: e.referenceReturnNumber ?? null,
        referenceReturnType: e.referenceReturnType ?? null,
        createdAt: e.createdAt,
        product: e.product
          ? { ...e.product, productType: e.product.productType ?? 'NEW' }
          : e.product,
        variant: e.variant,
        user: e.actor ?? null,
      })),
      pagination: ledger.pagination,
      groupCounts: ledger.groupCounts,
      facets: ledger.facets,
    };
  }

  async getProductTimeline(productPublicId) {
    const product = await prisma.product.findUnique({
      where: { publicId: productPublicId },
      select: {
        id: true,
        publicId: true,
        name: true,
        stock: true,
        reservedStock: true,
        reorderPoint: true,
      },
    });
    if (!product) throw new AppError(404, 'Product not found');

    const { listLedgerHistory } = await import('./inventory-ledger.service.js');

    const [ledgerResult, units, orderLines] = await Promise.all([
      listLedgerHistory({ productPublicId, page: 1, limit: 100 }),
      prisma.productUnit.findMany({
        where: { productId: product.id },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
      }),
      prisma.orderItem.findMany({
        where: { productId: product.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: {
          order: { select: { publicId: true, orderNumber: true, status: true, paymentStatus: true, createdAt: true } },
        },
      }),
    ]);

    return {
      product: {
        id: product.publicId,
        name: product.name,
        stock: product.stock,
        reservedStock: product.reservedStock,
        reorderPoint: product.reorderPoint,
      },
      ledger: ledgerResult.entries.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        quantityDelta: e.quantityDelta,
        referenceType: e.referenceType,
        referenceId: e.referenceId,
        referenceOrderNumber: e.referenceOrderNumber ?? null,
        referenceCheckoutIntentId: e.referenceCheckoutIntentId ?? null,
        referenceReturnNumber: e.referenceReturnNumber ?? null,
        referenceReturnType: e.referenceReturnType ?? null,
        note: e.note ?? null,
        createdAt: e.createdAt,
        variantSku: e.variant?.sku ?? null,
      })),
      units: units.map((u) => ({
        id: u.publicId,
        unitSku: u.unitSku,
        status: u.status,
        cycleNumber: u.cycleNumber,
        purchasedAt: u.purchasedAt,
        returnedAt: u.returnedAt,
        relistedAt: u.relistedAt,
        events: u.events.map((ev) => ({
          id: ev.publicId,
          fromStatus: ev.fromStatus,
          toStatus: ev.toStatus,
          note: ev.note,
          createdAt: ev.createdAt,
        })),
      })),
      orders: orderLines.map((li) => ({
        orderId: li.order.publicId,
        orderNumber: li.order.orderNumber,
        quantity: li.quantity,
        status: li.order.status,
        paymentStatus: li.order.paymentStatus,
        createdAt: li.order.createdAt,
      })),
    };
  }

  /**
   * Read-only Inventory Overview KPIs + activity for a single product (return detail / product admin).
   */
  async getProductOverview(productPublicId) {
    const product = await prisma.product.findUnique({
      where: { publicId: productPublicId },
      include: {
        category: { select: { publicId: true, name: true, slug: true } },
        variants: { orderBy: { sortOrder: 'asc' } },
        barcodes: { select: { code: true, productVariantId: true, publicId: true } },
      },
    });
    if (!product) throw new AppError(404, 'Product not found');

    const currentAvailable = computeAvailableStock(product);

    const ledgerAgg = await prisma.inventoryLedgerEvent.groupBy({
      by: ['eventType'],
      where: { productId: product.id },
      _sum: { quantityDelta: true },
    });
    const sumByType = Object.fromEntries(
      ledgerAgg.map((row) => [row.eventType, Math.abs(Number(row._sum.quantityDelta || 0))])
    );
    const signedByType = Object.fromEntries(
      ledgerAgg.map((row) => [row.eventType, Number(row._sum.quantityDelta || 0)])
    );

    const totalSold = sumByType.COMMIT || 0;
    const totalRestocked = (sumByType.RESTOCK || 0) + (sumByType.REFUND_RESTORE || 0);
    const positiveAdjust = Math.max(0, signedByType.ADJUST || 0);
    const totalReceived = positiveAdjust + totalRestocked;

    const returnRows = await prisma.returnRequest.findMany({
      where: {
        orderItem: { productId: product.id },
        type: 'STANDARD',
      },
      select: {
        publicId: true,
        returnNumber: true,
        receivedQuantity: true,
        quantity: true,
        disposition: true,
        dispositionQuantity: true,
        acceptedQuantity: true,
        status: true,
        updatedAt: true,
        createdAt: true,
        order: {
          select: {
            publicId: true,
            orderNumber: true,
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
    });

    let totalReturned = 0;
    let totalMovedToRefurb = 0;
    let totalDiscarded = 0;
    for (const rr of returnRows) {
      totalReturned += Math.max(0, Number(rr.receivedQuantity ?? 0));
      const dispQty = Math.max(
        0,
        Number(rr.dispositionQuantity ?? rr.acceptedQuantity ?? 0)
      );
      if (rr.disposition === 'REFURB') totalMovedToRefurb += dispQty;
      if (rr.disposition === 'DISCARD') totalDiscarded += dispQty;
    }

    const { listLedgerHistory } = await import('./inventory-ledger.service.js');
    const ledgerResult = await listLedgerHistory({
      productPublicId,
      page: 1,
      limit: 80,
    });

    // Enrich order customers for activity rows
    const orderIds = [
      ...new Set(
        ledgerResult.entries
          .filter((e) => e.referenceType === 'order' && e.referenceId)
          .map((e) => e.referenceId)
      ),
    ];
    const ordersWithUsers =
      orderIds.length > 0
        ? await prisma.order.findMany({
            where: { publicId: { in: orderIds } },
            select: {
              publicId: true,
              orderNumber: true,
              user: { select: { firstName: true, lastName: true, email: true } },
            },
          })
        : [];
    const customerByOrder = new Map(
      ordersWithUsers.map((o) => [
        o.publicId,
        [o.user?.firstName, o.user?.lastName].filter(Boolean).join(' ').trim() ||
          o.user?.email ||
          null,
      ])
    );

    const activity = [];

    for (const e of ledgerResult.entries) {
      if (e.eventType === 'RESERVE' || e.eventType === 'RELEASE') continue;
      let action = e.eventType;
      if (e.eventType === 'COMMIT') action = 'SOLD';
      else if (e.eventType === 'RESTOCK' || e.eventType === 'REFUND_RESTORE') action = 'RESTOCKED';
      else if (e.eventType === 'ADJUST') {
        const note = String(e.note || '');
        if (/discard/i.test(note)) action = 'DISCARDED';
        else if (/refurb/i.test(note)) action = 'MOVED_TO_REFURB';
        else action = 'MANUAL_ADJUSTMENT';
      }
      const teamMember = e.actor
        ? [e.actor.firstName, e.actor.lastName].filter(Boolean).join(' ').trim() || e.actor.email
        : null;
      const isTeam =
        e.actor?.role === 'ADMIN' || e.actor?.role === 'ADMIN_TEAM';
      activity.push({
        id: e.id,
        createdAt: e.createdAt,
        action,
        eventType: e.eventType,
        quantity: Math.abs(Number(e.quantityDelta || 0)),
        quantityDelta: e.quantityDelta,
        orderId: e.referenceType === 'order' ? e.referenceId : null,
        orderNumber: e.referenceOrderNumber || null,
        returnNumber: e.referenceReturnNumber || null,
        customerName:
          e.referenceType === 'order' && e.referenceId
            ? customerByOrder.get(e.referenceId) || null
            : null,
        teamMember: isTeam ? teamMember : null,
        actorName: teamMember,
        note: e.note || null,
      });
    }

    // Disposition rows that may predate ledger writes
    for (const rr of returnRows) {
      if (rr.disposition !== 'DISCARD' && rr.disposition !== 'REFURB') continue;
      const qty = Math.max(0, Number(rr.dispositionQuantity ?? rr.acceptedQuantity ?? 0));
      if (qty <= 0) continue;
      const already = activity.some(
        (a) =>
          a.returnNumber === rr.returnNumber &&
          ((rr.disposition === 'DISCARD' && a.action === 'DISCARDED') ||
            (rr.disposition === 'REFURB' && a.action === 'MOVED_TO_REFURB'))
      );
      if (already) continue;
      const customer =
        [rr.order?.user?.firstName, rr.order?.user?.lastName].filter(Boolean).join(' ').trim() ||
        rr.order?.user?.email ||
        null;
      activity.push({
        id: `disp-${rr.publicId}`,
        createdAt: rr.updatedAt || rr.createdAt,
        action: rr.disposition === 'DISCARD' ? 'DISCARDED' : 'MOVED_TO_REFURB',
        eventType: 'ADJUST',
        quantity: qty,
        quantityDelta: 0,
        orderId: rr.order?.publicId || null,
        orderNumber: rr.order?.orderNumber || null,
        returnNumber: rr.returnNumber || rr.publicId,
        customerName: customer,
        teamMember: null,
        actorName: null,
        note: `Return disposition ${rr.disposition}`,
      });
    }

    // Received units as Returned activity (when not already represented)
    for (const rr of returnRows) {
      const qty = Math.max(0, Number(rr.receivedQuantity ?? 0));
      if (qty <= 0) continue;
      activity.push({
        id: `ret-${rr.publicId}`,
        createdAt: rr.updatedAt || rr.createdAt,
        action: 'RETURNED',
        eventType: 'RETURN',
        quantity: qty,
        quantityDelta: 0,
        orderId: rr.order?.publicId || null,
        orderNumber: rr.order?.orderNumber || null,
        returnNumber: rr.returnNumber || rr.publicId,
        customerName:
          [rr.order?.user?.firstName, rr.order?.user?.lastName].filter(Boolean).join(' ').trim() ||
          rr.order?.user?.email ||
          null,
        teamMember: null,
        actorName: null,
        note: 'Units received on return',
      });
    }

    activity.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const variants = (product.variants || []).map((v) => {
      const reservedStock = v.reservedStock ?? 0;
      const availableStock = variantAvailableStock(v);
      const barcodeCode =
        (product.barcodes || []).find((b) => b.productVariantId === v.id)?.code ?? null;
      return {
        id: v.publicId,
        sku: v.sku,
        label: combinationLabel(v.combination),
        stock: v.stock,
        reservedStock,
        availableStock,
        stockStatus: stockStatusFromAvailable(availableStock, product.reorderPoint, product.productType),
        warehouseLocation: v.warehouseLocation || null,
        imageUrl: v.imageUrl || null,
        barcodeCode,
        price: v.memberPriceOverride ?? v.priceOverride ?? product.memberPrice ?? product.unitPriceAmount ?? null,
      };
    });

    return {
      product: {
        id: product.publicId,
        name: product.name,
        sku: product.sku,
        productType: product.productType,
        imageUrl: product.imageUrl || null,
        isActiveListing: product.isActiveListing !== false,
        reorderPoint: product.reorderPoint ?? null,
        warehouseLocation: product.warehouseLocation || null,
        price: product.memberPrice ?? product.unitPriceAmount ?? null,
        stock: product.stock,
        reservedStock: product.reservedStock ?? 0,
        availableStock: currentAvailable,
        barcodeCode: (product.barcodes || []).find((b) => b.productVariantId == null)?.code ?? null,
        category: product.category
          ? { id: product.category.publicId, name: product.category.name, slug: product.category.slug }
          : null,
      },
      variants,
      kpis: {
        totalInventoryReceived: totalReceived,
        totalSold,
        totalReturned,
        totalRestocked,
        totalMovedToRefurbishment: totalMovedToRefurb,
        totalDiscarded,
        currentAvailableInventory: currentAvailable,
        manualAdjustments: Math.abs(Number(signedByType.ADJUST || 0)),
      },
      activity: activity.slice(0, 100),
    };
  }
}

/**
 * Validates aggregate stock and decreases inventory for an order line (transaction context).
 */
export async function assertAndDecrementOrderStock(tx, product, quantity) {
  if (quantity < 1) return;
  if (product.isDraft || !product.isActiveListing) {
    throw new AppError(400, `Product "${product.name}" is not available for purchase`);
  }
  const total = computeTotalStock(product);
  if (total < quantity) {
    throw new AppError(400, `Insufficient stock for "${product.name}"`);
  }
  await decrementOrderStockFromProduct(tx, product, quantity);
}

export const inventoryService = new InventoryService();
