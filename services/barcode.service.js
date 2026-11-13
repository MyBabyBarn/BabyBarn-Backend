import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { writeAdminAudit } from './audit.service.js';
import { renderBarcodeLabelPdf } from './pdf/barcode-labels.js';
import { renderCode128Png } from '../lib/code128.js';
import {
  barcodeTargetKey,
  isBarcodeCode,
  newBarcodeCode,
  normalizeBarcodeCode,
} from '../lib/barcode-code.js';

const PRODUCT_LIVE = {
  id: true,
  publicId: true,
  name: true,
  sku: true,
  price: true,
  memberPrice: true,
  stock: true,
  reservedStock: true,
  productType: true,
  warehouseLocation: true,
  imageUrl: true,
  isDraft: true,
};

const VARIANT_LIVE = {
  id: true,
  publicId: true,
  sku: true,
  combination: true,
  stock: true,
  reservedStock: true,
  priceOverride: true,
  memberPriceOverride: true,
  warehouseLocation: true,
};

const BARCODE_INCLUDE = {
  product: { select: PRODUCT_LIVE },
  productVariant: { select: VARIANT_LIVE },
  aliases: { select: { code: true } },
};

function db(tx) {
  return tx || prisma;
}

function variantLabel(combination) {
  if (!combination || typeof combination !== 'object') return '—';
  const entries = Object.entries(combination);
  if (entries.length === 0) return '—';
  return entries.map(([k, val]) => `${k}: ${String(val)}`).join(' · ');
}

function availableOf(onHand, reserved) {
  return Math.max(0, Number(onHand || 0) - Number(reserved || 0));
}

async function allocateCode(tx) {
  for (let i = 0; i < 20; i += 1) {
    const code = newBarcodeCode();
    const taken =
      (await db(tx).productBarcode.findUnique({ where: { code }, select: { id: true } })) ||
      (await db(tx).productBarcodeAlias.findUnique({ where: { code }, select: { id: true } }));
    if (!taken) return code;
  }
  throw new AppError(500, 'Could not generate barcode');
}

/** Prototype label workflow: Generated → Printed → Sent. */
export function barcodeWorkflowStatus(row) {
  if (row.sentToVendorAt) return 'Sent';
  if (row.printedAt) return 'Printed';
  return 'Generated';
}

export function toLookup(row) {
  const product = row.product;
  const variant = row.productVariant;
  const onHand = variant ? variant.stock : product.stock;
  const reserved = variant ? variant.reservedStock : product.reservedStock;
  const location = variant?.warehouseLocation || product.warehouseLocation || null;
  const price = variant?.priceOverride != null ? variant.priceOverride : product.price;
  const status = barcodeWorkflowStatus(row);
  return {
    id: row.publicId,
    code: row.code,
    status,
    printedAt: row.printedAt,
    sentToVendorAt: row.sentToVendorAt,
    createdAt: row.createdAt,
    aliases: (row.aliases || []).map((a) => a.code),
    warehouseLocation: location,
    product: {
      id: product.publicId,
      name: product.name,
      sku: product.sku,
      price: product.price,
      memberPrice: product.memberPrice,
      stock: product.stock,
      reservedStock: product.reservedStock,
      availableStock: availableOf(product.stock, product.reservedStock),
      productType: product.productType,
      warehouseLocation: product.warehouseLocation || null,
      imageUrl: product.imageUrl || null,
    },
    variant: variant
      ? {
          id: variant.publicId,
          sku: variant.sku,
          combination: variant.combination,
          variantLabel: variantLabel(variant.combination),
          price,
          stock: variant.stock,
          reservedStock: variant.reservedStock,
          availableStock: availableOf(variant.stock, variant.reservedStock),
          memberPrice: variant.memberPriceOverride ?? product.memberPrice,
          warehouseLocation: variant.warehouseLocation || null,
        }
      : null,
    sku: variant?.sku || product.sku,
    name: product.name,
    onHand,
    reservedStock: reserved,
    availableStock: availableOf(onHand, reserved),
  };
}

async function findByTarget(tx, targetKey) {
  return db(tx).productBarcode.findUnique({
    where: { targetKey },
    include: BARCODE_INCLUDE,
  });
}

async function findByCode(code, tx) {
  const normalized = normalizeBarcodeCode(code);
  const primary = await db(tx).productBarcode.findUnique({
    where: { code: normalized },
    include: BARCODE_INCLUDE,
  });
  if (primary) return primary;
  const alias = await db(tx).productBarcodeAlias.findUnique({
    where: { code: normalized },
    include: { productBarcode: { include: BARCODE_INCLUDE } },
  });
  return alias?.productBarcode || null;
}

/**
 * Idempotent. Creates a code once per sellable line; never regenerates after send.
 */
export async function ensureBarcode({ productId, variantId = null }, tx) {
  const targetKey = barcodeTargetKey({ productId, variantId });
  const existing = await findByTarget(tx, targetKey);
  if (existing) return existing;

  const product = await db(tx).product.findUnique({
    where: { id: productId },
    select: { id: true },
  });
  if (!product) throw new AppError(404, 'Product not found');

  if (variantId) {
    const variant = await db(tx).productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true },
    });
    if (!variant) throw new AppError(404, 'Variant not found');
  }

  const code = await allocateCode(tx);
  try {
    return await db(tx).productBarcode.create({
      data: { code, targetKey, productId, productVariantId: variantId },
      include: BARCODE_INCLUDE,
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      const raced = await findByTarget(tx, targetKey);
      if (raced) return raced;
    }
    throw err;
  }
}

export async function ensureBarcodesForProduct(productId, tx) {
  const product = await db(tx).product.findUnique({
    where: { id: productId },
    include: { variants: { select: { id: true }, orderBy: { sortOrder: 'asc' } } },
  });
  if (!product) throw new AppError(404, 'Product not found');

  if (product.variants.length === 0) {
    return [await ensureBarcode({ productId, variantId: null }, tx)];
  }
  const rows = [];
  for (const v of product.variants) {
    rows.push(await ensureBarcode({ productId, variantId: v.id }, tx));
  }
  return rows;
}

export async function snapshotVariantBarcodeSkus(tx, productId) {
  const rows = await db(tx).productBarcode.findMany({
    where: { productId, productVariantId: { not: null } },
    select: { id: true, productVariant: { select: { sku: true } } },
  });
  return rows
    .filter((r) => r.productVariant?.sku)
    .map((r) => ({ barcodeId: r.id, sku: r.productVariant.sku }));
}

export async function reattachVariantBarcodes(tx, productId, snapshot) {
  if (!snapshot?.length) return;
  const variants = await db(tx).productVariant.findMany({
    where: { productId },
    select: { id: true, sku: true },
  });
  const bySku = new Map(variants.map((v) => [v.sku, v.id]));
  for (const row of snapshot) {
    const variantId = bySku.get(row.sku);
    if (!variantId) continue;
    await db(tx).productBarcode.update({
      where: { id: row.barcodeId },
      data: { productVariantId: variantId, targetKey: barcodeTargetKey({ productId, variantId }) },
    });
  }
}

export async function listForProductPublicId(productPublicId) {
  const product = await prisma.product.findUnique({
    where: { publicId: productPublicId },
    select: { id: true },
  });
  if (!product) throw new AppError(404, 'Product not found');
  const rows = await ensureBarcodesForProduct(product.id);
  return rows.map(toLookup);
}

/**
 * Global Labels & barcodes catalog (prototype #/m/barcodes).
 * Read-only listing — does not ensure missing codes.
 */
export async function listCatalog({
  q = '',
  status = 'all',
  type = 'all',
  page = 1,
  per = 12,
} = {}) {
  const productFilter = {
    isDraft: false,
    ...(type === 'new' ? { productType: 'NEW' } : {}),
    ...(type === 'refurbished' ? { productType: 'REFURBISHED' } : {}),
  };

  const and = [{ product: productFilter }];

  if (status === 'Generated') {
    and.push({ printedAt: null, sentToVendorAt: null });
  } else if (status === 'Printed') {
    and.push({ printedAt: { not: null }, sentToVendorAt: null });
  } else if (status === 'Sent') {
    and.push({ sentToVendorAt: { not: null } });
  }

  const needle = String(q || '').trim();
  if (needle) {
    and.push({
      OR: [
        { code: { contains: needle, mode: 'insensitive' } },
        { product: { name: { contains: needle, mode: 'insensitive' } } },
        { product: { sku: { contains: needle, mode: 'insensitive' } } },
        { productVariant: { sku: { contains: needle, mode: 'insensitive' } } },
      ],
    });
  }

  const where = { AND: and };
  const baseWhere = { product: productFilter };

  const [total, rows, kpiAll, kpiGenerated, kpiPrinted, kpiSent] = await Promise.all([
    prisma.productBarcode.count({ where }),
    prisma.productBarcode.findMany({
      where,
      include: BARCODE_INCLUDE,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * per,
      take: per,
    }),
    prisma.productBarcode.count({ where: baseWhere }),
    prisma.productBarcode.count({
      where: { ...baseWhere, printedAt: null, sentToVendorAt: null },
    }),
    prisma.productBarcode.count({
      where: { ...baseWhere, printedAt: { not: null }, sentToVendorAt: null },
    }),
    prisma.productBarcode.count({
      where: { ...baseWhere, sentToVendorAt: { not: null } },
    }),
  ]);

  return {
    items: rows.map(toLookup),
    total,
    page,
    per,
    pages: Math.max(1, Math.ceil(total / per)),
    kpis: {
      all: kpiAll,
      generated: kpiGenerated,
      printed: kpiPrinted,
      sent: kpiSent,
    },
  };
}

async function findSellableBySku(sku) {
  const q = String(sku || '').trim();
  if (!q) return null;
  const variant = await prisma.productVariant.findFirst({
    where: { sku: { equals: q, mode: 'insensitive' } },
    select: { id: true, productId: true },
  });
  if (variant) return { productId: variant.productId, variantId: variant.id };
  const product = await prisma.product.findFirst({
    where: { sku: { equals: q, mode: 'insensitive' } },
    select: { id: true, inventoryModel: true, variants: { select: { id: true }, take: 1 } },
  });
  if (!product) return null;
  if (product.variants.length > 0) {
    throw new AppError(400, 'This product has variants — scan or enter the variant SKU.', 'VARIANT_SKU_REQUIRED');
  }
  return { productId: product.id, variantId: null };
}

/** Resolve BBP code, alias, or SKU. Optionally ensure a barcode when the query is a SKU. */
export async function lookup(query, { ensureIfSku = false } = {}) {
  const raw = String(query || '').trim();
  if (!raw) throw new AppError(400, 'Barcode or SKU is required');

  const asCode = await findByCode(raw);
  if (asCode) return toLookup(asCode);

  const sellable = await findSellableBySku(raw);
  if (!sellable) throw new AppError(404, 'Barcode not found', 'BARCODE_NOT_FOUND');
  const row = ensureIfSku
    ? await ensureBarcode(sellable)
    : await findByTarget(null, barcodeTargetKey(sellable));
  if (!row) throw new AppError(404, 'Barcode not found', 'BARCODE_NOT_FOUND');
  return toLookup(row);
}

export async function ensureBySku(sku) {
  const sellable = await findSellableBySku(sku);
  if (!sellable) throw new AppError(404, 'SKU not found', 'SKU_NOT_FOUND');
  return toLookup(await ensureBarcode(sellable));
}

export async function markSent(code, actor) {
  const row = await findByCode(code);
  if (!row) throw new AppError(404, 'Barcode not found', 'BARCODE_NOT_FOUND');
  if (row.sentToVendorAt) return toLookup(row);

  const updated = await prisma.productBarcode.update({
    where: { id: row.id },
    data: {
      sentToVendorAt: new Date(),
      printedAt: row.printedAt || new Date(),
    },
    include: BARCODE_INCLUDE,
  });
  await writeAdminAudit({
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    action: 'BARCODE_SENT_TO_VENDOR',
    entityType: 'ProductBarcode',
    entityId: updated.code,
    meta: { productId: updated.product.publicId, variantId: updated.productVariant?.publicId ?? null },
  });
  return toLookup(updated);
}

export async function markPrinted(code, actor) {
  const row = await findByCode(code);
  if (!row) throw new AppError(404, 'Barcode not found', 'BARCODE_NOT_FOUND');
  if (row.printedAt || row.sentToVendorAt) return toLookup(row);

  const updated = await prisma.productBarcode.update({
    where: { id: row.id },
    data: { printedAt: new Date() },
    include: BARCODE_INCLUDE,
  });
  await writeAdminAudit({
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    action: 'BARCODE_PRINTED',
    entityType: 'ProductBarcode',
    entityId: updated.code,
    meta: { productId: updated.product.publicId, variantId: updated.productVariant?.publicId ?? null },
  });
  return toLookup(updated);
}

export async function markPrintedMany(codes, actor) {
  const out = [];
  for (const code of codes) {
    out.push(await markPrinted(code, actor));
  }
  return out;
}

export async function markSentMany(codes, actor) {
  const out = [];
  for (const code of codes) {
    out.push(await markSent(code, actor));
  }
  return out;
}

export async function regenerate(code, { confirmSent = false, actor } = {}) {
  const row = await findByCode(code);
  if (!row) throw new AppError(404, 'Barcode not found', 'BARCODE_NOT_FOUND');

  if (row.sentToVendorAt && !confirmSent) {
    throw new AppError(
      409,
      'This barcode was sent to a vendor. Confirm regenerate to issue a new code; the old code stays scannable.',
      'BARCODE_SENT'
    );
  }

  const nextCode = await allocateCode();
  const updated = await prisma.$transaction(async (tx) => {
    if (row.sentToVendorAt) {
      await tx.productBarcodeAlias.create({
        data: { code: row.code, productBarcodeId: row.id },
      });
    }
    return tx.productBarcode.update({
      where: { id: row.id },
      data: { code: nextCode, sentToVendorAt: null, printedAt: null },
      include: BARCODE_INCLUDE,
    });
  });

  await writeAdminAudit({
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    action: 'BARCODE_REGENERATED',
    entityType: 'ProductBarcode',
    entityId: updated.code,
    meta: { previousCode: row.code, aliased: Boolean(row.sentToVendorAt) },
  });
  return toLookup(updated);
}

export async function updateLocation(query, warehouseLocation, actor) {
  const hit = await lookup(query, { ensureIfSku: true });
  const location = warehouseLocation == null ? null : String(warehouseLocation).trim() || null;
  if (hit.variant?.id) {
    await prisma.productVariant.update({
      where: { publicId: hit.variant.id },
      data: { warehouseLocation: location },
    });
  } else {
    await prisma.product.update({
      where: { publicId: hit.product.id },
      data: { warehouseLocation: location },
    });
  }
  await writeAdminAudit({
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    action: 'BARCODE_LOCATION_UPDATED',
    entityType: 'ProductBarcode',
    entityId: hit.code,
    meta: { warehouseLocation: location },
  });
  return lookup(hit.code);
}

async function labelsForCodes(codes) {
  const unique = [...new Set(codes.map(normalizeBarcodeCode).filter(Boolean))];
  if (unique.length === 0) throw new AppError(400, 'No valid barcode codes');
  const labels = [];
  for (const raw of unique) {
    const row = await findByCode(raw);
    if (!row) throw new AppError(404, `Barcode not found: ${raw}`, 'BARCODE_NOT_FOUND');
    const dto = toLookup(row);
    labels.push({
      code: dto.code,
      name: dto.name,
      sku: dto.sku,
      variantLabel: dto.variant?.variantLabel || null,
      location: dto.warehouseLocation,
    });
  }
  return labels;
}

export async function renderLabelPdf(codes) {
  return renderBarcodeLabelPdf(await labelsForCodes(codes));
}

export async function renderLabelPng(code) {
  const row = await findByCode(code);
  if (!row) throw new AppError(404, 'Barcode not found', 'BARCODE_NOT_FOUND');
  return renderCode128Png(row.code, { scale: 3, height: 14 });
}

export const barcodeService = {
  ensureBarcode,
  ensureBarcodesForProduct,
  snapshotVariantBarcodeSkus,
  reattachVariantBarcodes,
  listForProductPublicId,
  listCatalog,
  lookup,
  ensureBySku,
  markSent,
  markSentMany,
  markPrinted,
  markPrintedMany,
  regenerate,
  updateLocation,
  renderLabelPdf,
  renderLabelPng,
  toLookup,
  barcodeWorkflowStatus,
};
