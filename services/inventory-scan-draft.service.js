import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { barcodeTargetKey } from '../lib/barcode-code.js';
import { lookup } from './barcode.service.js';
import { writeAdminAudit } from './audit.service.js';
import { inventoryService } from './inventory.service.js';

const LINE_ACTIONS = new Set(['NO_CHANGE', 'ADD', 'REMOVE', 'SET']);

const sessionInclude = {
  lines: {
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      product: {
        select: {
          publicId: true,
          name: true,
          sku: true,
          imageUrl: true,
          stock: true,
          reservedStock: true,
          warehouseLocation: true,
          stockVersion: true,
        },
      },
      productVariant: {
        select: {
          publicId: true,
          sku: true,
          combination: true,
          stock: true,
          reservedStock: true,
          warehouseLocation: true,
          stockVersion: true,
          imageUrl: true,
        },
      },
    },
  },
};

function availableOf(onHand, reserved) {
  return Math.max(0, Number(onHand || 0) - Number(reserved || 0));
}

function variantLabel(combination) {
  if (!combination || typeof combination !== 'object') return null;
  const entries = Object.entries(combination);
  if (entries.length === 0) return null;
  return entries.map(([k, val]) => `${k}: ${String(val)}`).join(' · ');
}

function toPublicLine(line) {
  const onHand = line.productVariant ? line.productVariant.stock : line.product.stock;
  const reserved = line.productVariant
    ? line.productVariant.reservedStock
    : line.product.reservedStock;
  const available = availableOf(onHand, reserved);
  const location =
    line.productVariant?.warehouseLocation || line.product.warehouseLocation || null;
  let afterUpdate = onHand;
  if (line.action === 'ADD') afterUpdate = onHand + line.pendingQty;
  else if (line.action === 'REMOVE') afterUpdate = Math.max(0, onHand - line.pendingQty);
  else if (line.action === 'SET') afterUpdate = line.pendingQty;

  return {
    id: line.publicId,
    barcodeCode: line.barcodeCode,
    targetKey: line.targetKey,
    scannedCount: line.scannedCount,
    action: line.action,
    pendingQty: line.pendingQty,
    expectedOnHand: line.expectedOnHand,
    expectedAvailable: line.expectedAvailable,
    expectedStockVersion: line.expectedStockVersion,
    reason: line.reason,
    note: line.note,
    sortOrder: line.sortOrder,
    currentOnHand: onHand,
    currentAvailable: available,
    currentReserved: reserved,
    afterUpdate,
    location,
    product: {
      id: line.product.publicId,
      name: line.product.name,
      sku: line.product.sku,
      imageUrl: line.product.imageUrl,
    },
    variant: line.productVariant
      ? {
          id: line.productVariant.publicId,
          sku: line.productVariant.sku,
          variantLabel: variantLabel(line.productVariant.combination),
          imageUrl: line.productVariant.imageUrl,
        }
      : null,
  };
}

function toPublicSession(session) {
  return {
    id: session.publicId,
    status: session.status,
    sessionNote: session.sessionNote,
    location: session.location,
    confirmedAt: session.confirmedAt,
    discardedAt: session.discardedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lines: (session.lines || []).map(toPublicLine),
  };
}

async function findActorUser(userPublicId) {
  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: { id: true, publicId: true, email: true },
  });
  if (!user) throw new AppError(401, 'Unauthorized');
  return user;
}

async function getDraftOwned(sessionPublicId, userId) {
  const session = await prisma.inventoryScanSession.findUnique({
    where: { publicId: sessionPublicId },
    include: sessionInclude,
  });
  if (!session || session.createdById !== userId) {
    throw new AppError(404, 'Draft session not found');
  }
  if (session.status !== 'DRAFT') {
    throw new AppError(409, 'Session is no longer a draft', 'SESSION_NOT_DRAFT');
  }
  return session;
}

export async function getOrCreateActiveDraft({ userPublicId }) {
  const user = await findActorUser(userPublicId);
  const existing = await prisma.inventoryScanSession.findFirst({
    where: { createdById: user.id, status: 'DRAFT' },
    orderBy: { updatedAt: 'desc' },
    include: sessionInclude,
  });
  if (existing) return toPublicSession(existing);

  const created = await prisma.inventoryScanSession.create({
    data: { createdById: user.id, status: 'DRAFT' },
    include: sessionInclude,
  });
  return toPublicSession(created);
}

export async function getDraftSession({ sessionPublicId, userPublicId }) {
  const user = await findActorUser(userPublicId);
  const session = await getDraftOwned(sessionPublicId, user.id);
  return toPublicSession(session);
}

/** Read any owned session (draft, confirmed, or discarded) for past-session detail. */
export async function getOwnedSession({ sessionPublicId, userPublicId }) {
  const user = await findActorUser(userPublicId);
  const session = await prisma.inventoryScanSession.findUnique({
    where: { publicId: sessionPublicId },
    include: {
      ...sessionInclude,
      createdBy: { select: { publicId: true, email: true, firstName: true, lastName: true } },
    },
  });
  if (!session || session.createdById !== user.id) {
    throw new AppError(404, 'Session not found');
  }
  const pub = toPublicSession(session);
  return {
    ...pub,
    createdBy: session.createdBy
      ? {
          id: session.createdBy.publicId,
          email: session.createdBy.email,
          name: [session.createdBy.firstName, session.createdBy.lastName].filter(Boolean).join(' ') || null,
        }
      : null,
    summary: summarizeLines(session.lines || []),
  };
}

function summarizeLines(lines) {
  let unitsIn = 0;
  let unitsOut = 0;
  let unitsAdjust = 0;
  let productsChanged = 0;
  for (const line of lines) {
    if (line.action === 'NO_CHANGE') continue;
    productsChanged += 1;
    if (line.action === 'ADD') unitsIn += Number(line.pendingQty || 0);
    else if (line.action === 'REMOVE') unitsOut += Number(line.pendingQty || 0);
    else if (line.action === 'SET') {
      const baseline = Number(line.expectedOnHand ?? 0);
      unitsAdjust += Math.abs(Number(line.pendingQty || 0) - baseline);
    }
  }
  return {
    productsChanged,
    lineCount: lines.length,
    unitsIn,
    unitsOut,
    unitsAdjust,
    operationTypes: [
      ...new Set(lines.filter((l) => l.action !== 'NO_CHANGE').map((l) => l.action)),
    ],
  };
}

/**
 * List past sessions for the signed-in user (excludes active DRAFT by default unless status=DRAFT).
 */
export async function listSessions({
  userPublicId,
  status,
  search,
  page = 1,
  limit = 20,
}) {
  const user = await findActorUser(userPublicId);
  const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = { createdById: user.id };
  if (status && ['DRAFT', 'CONFIRMED', 'DISCARDED'].includes(String(status).toUpperCase())) {
    where.status = String(status).toUpperCase();
  } else {
    // Default: past work — completed + discarded + drafts (all for tabs)
    where.status = { in: ['DRAFT', 'CONFIRMED', 'DISCARDED'] };
  }
  if (search?.trim()) {
    const q = search.trim();
    where.OR = [
      { publicId: { contains: q, mode: 'insensitive' } },
      { sessionNote: { contains: q, mode: 'insensitive' } },
      { location: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.inventoryScanSession.count({ where }),
    prisma.inventoryScanSession.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take,
      include: {
        lines: {
          select: {
            action: true,
            pendingQty: true,
            expectedOnHand: true,
            productId: true,
          },
        },
        createdBy: { select: { publicId: true, email: true, firstName: true, lastName: true } },
      },
    }),
  ]);

  const items = rows.map((session) => {
    const summary = summarizeLines(session.lines);
    return {
      id: session.publicId,
      status: session.status,
      sessionNote: session.sessionNote,
      location: session.location,
      confirmedAt: session.confirmedAt,
      discardedAt: session.discardedAt,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      name:
        session.sessionNote?.trim() ||
        (session.status === 'DRAFT'
          ? 'Draft session'
          : session.status === 'CONFIRMED'
            ? 'Inventory update'
            : 'Discarded session'),
      createdBy: session.createdBy
        ? {
            id: session.createdBy.publicId,
            email: session.createdBy.email,
            name:
              [session.createdBy.firstName, session.createdBy.lastName].filter(Boolean).join(' ') ||
              null,
          }
        : null,
      summary,
    };
  });

  const [drafts, completed, discarded] = await Promise.all([
    prisma.inventoryScanSession.count({ where: { createdById: user.id, status: 'DRAFT' } }),
    prisma.inventoryScanSession.count({ where: { createdById: user.id, status: 'CONFIRMED' } }),
    prisma.inventoryScanSession.count({ where: { createdById: user.id, status: 'DISCARDED' } }),
  ]);

  return {
    items,
    page: Math.max(Number(page) || 1, 1),
    limit: take,
    total,
    stats: {
      totalSessions: drafts + completed + discarded,
      drafts,
      completed,
      discarded,
    },
  };
}

/**
 * Resolve barcode/SKU and upsert a draft line. Increments scannedCount only — no ledger write.
 */
export async function identifyAndUpsertLine({
  sessionPublicId,
  userPublicId,
  code,
  incrementScanned = true,
}) {
  const user = await findActorUser(userPublicId);
  const session = await getDraftOwned(sessionPublicId, user.id);
  const hit = await lookup(code, { ensureIfSku: true });
  const productDb = await prisma.product.findUnique({
    where: { publicId: hit.product.id },
    select: { id: true, stock: true, reservedStock: true, stockVersion: true },
  });
  if (!productDb) throw new AppError(404, 'Product not found');

  let variantDb = null;
  if (hit.variant?.id) {
    variantDb = await prisma.productVariant.findUnique({
      where: { publicId: hit.variant.id },
      select: { id: true, stock: true, reservedStock: true, stockVersion: true },
    });
    if (!variantDb) throw new AppError(404, 'Variant not found');
  }

  const targetKey = barcodeTargetKey({
    productId: productDb.id,
    variantId: variantDb?.id ?? null,
  });
  const onHand = variantDb ? variantDb.stock : productDb.stock;
  const reserved = variantDb ? variantDb.reservedStock : productDb.reservedStock;
  const available = availableOf(onHand, reserved);
  const stockVersion = variantDb ? variantDb.stockVersion : productDb.stockVersion;

  const existing = session.lines.find((l) => l.targetKey === targetKey);
  let line;
  if (existing) {
    line = await prisma.inventoryScanSessionLine.update({
      where: { id: existing.id },
      data: {
        barcodeCode: hit.code,
        scannedCount: incrementScanned ? existing.scannedCount + 1 : existing.scannedCount,
        expectedOnHand: onHand,
        expectedAvailable: available,
        expectedStockVersion: stockVersion,
      },
      include: sessionInclude.lines.include,
    });
  } else {
    const maxSort = session.lines.reduce((m, l) => Math.max(m, l.sortOrder), -1);
    line = await prisma.inventoryScanSessionLine.create({
      data: {
        sessionId: session.id,
        targetKey,
        barcodeCode: hit.code,
        productId: productDb.id,
        productVariantId: variantDb?.id ?? null,
        scannedCount: incrementScanned ? 1 : 0,
        action: 'NO_CHANGE',
        pendingQty: 0,
        expectedOnHand: onHand,
        expectedAvailable: available,
        expectedStockVersion: stockVersion,
        sortOrder: maxSort + 1,
      },
      include: sessionInclude.lines.include,
    });
  }

  await prisma.inventoryScanSession.update({
    where: { id: session.id },
    data: { updatedAt: new Date() },
  });

  const refreshed = await prisma.inventoryScanSession.findUnique({
    where: { id: session.id },
    include: sessionInclude,
  });
  return { session: toPublicSession(refreshed), line: toPublicLine(line), lookup: hit };
}

export async function updateDraftLine({
  sessionPublicId,
  linePublicId,
  userPublicId,
  action,
  pendingQty,
  reason,
  note,
  refreshExpectations = false,
}) {
  const user = await findActorUser(userPublicId);
  const session = await getDraftOwned(sessionPublicId, user.id);
  const line = session.lines.find((l) => l.publicId === linePublicId);
  if (!line) throw new AppError(404, 'Session line not found');

  const data = {};
  if (action != null) {
    const next = String(action).toUpperCase();
    if (!LINE_ACTIONS.has(next)) throw new AppError(400, 'Invalid line action');
    data.action = next;
  }
  if (pendingQty != null) {
    const qty = Number(pendingQty);
    if (!Number.isInteger(qty) || qty < 0) {
      throw new AppError(400, 'Pending quantity must be a whole number ≥ 0');
    }
    data.pendingQty = qty;
  }
  if (reason !== undefined) data.reason = reason == null ? null : String(reason).trim() || null;
  if (note !== undefined) data.note = note == null ? null : String(note).trim() || null;

  if (refreshExpectations) {
    const onHand = line.productVariant ? line.productVariant.stock : line.product.stock;
    const reserved = line.productVariant
      ? line.productVariant.reservedStock
      : line.product.reservedStock;
    data.expectedOnHand = onHand;
    data.expectedAvailable = availableOf(onHand, reserved);
    data.expectedStockVersion = line.productVariant
      ? line.productVariant.stockVersion
      : line.product.stockVersion;
  }

  const nextAction = data.action ?? line.action;
  const nextQty = data.pendingQty ?? line.pendingQty;
  if (nextAction === 'REMOVE' && nextQty > (data.expectedAvailable ?? line.expectedAvailable)) {
    throw new AppError(
      400,
      `Cannot remove more than available (${data.expectedAvailable ?? line.expectedAvailable})`,
      'REMOVE_EXCEEDS_AVAILABLE'
    );
  }
  if (nextAction === 'NO_CHANGE') {
    data.pendingQty = 0;
  }

  await prisma.inventoryScanSessionLine.update({
    where: { id: line.id },
    data,
  });
  await prisma.inventoryScanSession.update({
    where: { id: session.id },
    data: { updatedAt: new Date() },
  });

  const refreshed = await prisma.inventoryScanSession.findUnique({
    where: { id: session.id },
    include: sessionInclude,
  });
  return toPublicSession(refreshed);
}

export async function removeDraftLine({ sessionPublicId, linePublicId, userPublicId }) {
  const user = await findActorUser(userPublicId);
  const session = await getDraftOwned(sessionPublicId, user.id);
  const line = session.lines.find((l) => l.publicId === linePublicId);
  if (!line) throw new AppError(404, 'Session line not found');
  await prisma.inventoryScanSessionLine.delete({ where: { id: line.id } });
  const refreshed = await prisma.inventoryScanSession.findUnique({
    where: { id: session.id },
    include: sessionInclude,
  });
  return toPublicSession(refreshed);
}

export async function updateDraftMeta({ sessionPublicId, userPublicId, sessionNote, location }) {
  const user = await findActorUser(userPublicId);
  const session = await getDraftOwned(sessionPublicId, user.id);
  const data = {};
  if (sessionNote !== undefined) {
    data.sessionNote = sessionNote == null ? null : String(sessionNote).trim() || null;
  }
  if (location !== undefined) {
    data.location = location == null ? null : String(location).trim() || null;
  }
  const updated = await prisma.inventoryScanSession.update({
    where: { id: session.id },
    data,
    include: sessionInclude,
  });
  return toPublicSession(updated);
}

export async function discardDraft({ sessionPublicId, userPublicId }) {
  const user = await findActorUser(userPublicId);
  const session = await getDraftOwned(sessionPublicId, user.id);
  const updated = await prisma.inventoryScanSession.update({
    where: { id: session.id },
    data: { status: 'DISCARDED', discardedAt: new Date() },
    include: sessionInclude,
  });
  return toPublicSession(updated);
}

function computeDelta(action, pendingQty, currentOnHand) {
  if (action === 'ADD') return pendingQty;
  if (action === 'REMOVE') return -pendingQty;
  if (action === 'SET') return pendingQty - currentOnHand;
  return 0;
}

export async function confirmDraft({ sessionPublicId, userPublicId }) {
  const user = await findActorUser(userPublicId);
  const session = await getDraftOwned(sessionPublicId, user.id);

  const conflicts = [];
  const plan = [];

  for (const line of session.lines) {
    if (line.action === 'NO_CHANGE' || line.pendingQty < 0) continue;

    const product = await prisma.product.findUnique({
      where: { id: line.productId },
      select: {
        id: true,
        publicId: true,
        stock: true,
        reservedStock: true,
        stockVersion: true,
        name: true,
        sku: true,
      },
    });
    if (!product) {
      conflicts.push({
        lineId: line.publicId,
        sku: line.product.sku,
        reason: 'Product no longer exists',
      });
      continue;
    }

    let variant = null;
    if (line.productVariantId) {
      variant = await prisma.productVariant.findUnique({
        where: { id: line.productVariantId },
        select: {
          id: true,
          publicId: true,
          stock: true,
          reservedStock: true,
          stockVersion: true,
          sku: true,
        },
      });
      if (!variant) {
        conflicts.push({
          lineId: line.publicId,
          sku: line.product.sku,
          reason: 'Variant no longer exists',
        });
        continue;
      }
    }

    const onHand = variant ? variant.stock : product.stock;
    const reserved = variant ? variant.reservedStock : product.reservedStock;
    const available = availableOf(onHand, reserved);
    const stockVersion = variant ? variant.stockVersion : product.stockVersion;

    if (
      onHand !== line.expectedOnHand ||
      available !== line.expectedAvailable ||
      stockVersion !== line.expectedStockVersion
    ) {
      conflicts.push({
        lineId: line.publicId,
        sku: variant?.sku || product.sku,
        reason: 'Stock changed since this line was scanned — review and update',
        expectedOnHand: line.expectedOnHand,
        currentOnHand: onHand,
        expectedAvailable: line.expectedAvailable,
        currentAvailable: available,
      });
      continue;
    }

    const delta = computeDelta(line.action, line.pendingQty, onHand);
    if (delta === 0) continue;

    if (line.action === 'REMOVE' && line.pendingQty > available) {
      conflicts.push({
        lineId: line.publicId,
        sku: variant?.sku || product.sku,
        reason: `Cannot remove ${line.pendingQty}; only ${available} available (reserved protected)`,
      });
      continue;
    }
    if (onHand + delta < reserved) {
      conflicts.push({
        lineId: line.publicId,
        sku: variant?.sku || product.sku,
        reason: `Adjustment would leave stock below reserved (${reserved})`,
      });
      continue;
    }

    plan.push({
      line,
      productPublicId: product.publicId,
      variantPublicId: variant?.publicId ?? null,
      delta,
      reason:
        line.reason?.trim() ||
        (line.action === 'ADD'
          ? 'Shipment received'
          : line.action === 'REMOVE'
            ? 'Stock removal'
            : 'Inventory set count'),
    });
  }

  if (conflicts.length > 0) {
    throw new AppError(409, 'Stock conflicts — review session lines before confirming', 'STOCK_CONFLICT', {
      conflicts,
    });
  }

  if (plan.length === 0) {
    throw new AppError(400, 'No stock changes to confirm. Set Add, Remove, or Set on at least one line.');
  }

  const results = [];
  await prisma.$transaction(async (tx) => {
    for (const step of plan) {
      const applied = await inventoryService.adjustStockInTx(tx, {
        productPublicId: step.productPublicId,
        variantPublicId: step.variantPublicId,
        delta: step.delta,
        reason: step.reason,
        userId: user.id,
        referenceId: session.publicId,
      });
      results.push({
        lineId: step.line.publicId,
        delta: applied.applied,
        sku: step.line.product.sku,
      });
    }
    await tx.inventoryScanSession.update({
      where: { id: session.id },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });
  });

  await writeAdminAudit({
    id: user.publicId,
    email: user.email,
    action: 'INVENTORY_SCAN_SESSION_CONFIRM',
    entityType: 'InventoryScanSession',
    entityId: session.publicId,
    meta: {
      linesChanged: results.length,
      unitsIn: results.filter((r) => r.delta > 0).reduce((s, r) => s + r.delta, 0),
      unitsOut: results.filter((r) => r.delta < 0).reduce((s, r) => s + Math.abs(r.delta), 0),
    },
  });

  const refreshed = await prisma.inventoryScanSession.findUnique({
    where: { id: session.id },
    include: sessionInclude,
  });

  return {
    session: toPublicSession(refreshed),
    summary: {
      productsChanged: results.length,
      unitsIn: results.filter((r) => r.delta > 0).reduce((s, r) => s + r.delta, 0),
      unitsOut: results.filter((r) => r.delta < 0).reduce((s, r) => s + Math.abs(r.delta), 0),
      results,
    },
  };
}

export const inventoryScanDraftService = {
  getOrCreateActiveDraft,
  getDraftSession,
  getOwnedSession,
  listSessions,
  identifyAndUpsertLine,
  updateDraftLine,
  removeDraftLine,
  updateDraftMeta,
  discardDraft,
  confirmDraft,
};
