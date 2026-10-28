/**
 * Append-only inventory ledger for reserve / commit / adjust / restock events.
 */

/** @typedef {{ referenceType: string; referenceId: string; actorUserId?: number | null; note?: string | null }} LedgerContext */

/** Prototype LGRP → DB InventoryLedgerEventType (TRANSFER/COUNT/REFURB_* not persisted yet). */
const LEDGER_GROUP_TYPES = {
  in: ['RESTOCK'],
  out: ['COMMIT'],
  tr: [],
  ret: ['REFUND_RESTORE'],
  ref: [],
  adj: ['ADJUST'],
};

/** @type {Record<string, string>} */
const LEDGER_SOURCE_BY_EVENT = {
  COMMIT: 'Order',
  RESERVE: 'Order',
  RELEASE: 'Order',
  RESTOCK: 'Manual',
  ADJUST: 'Manual',
  REFUND_RESTORE: 'Return',
};

/** @type {Record<string, string>} */
const LEDGER_SOURCE_BY_REF = {
  order: 'Order',
  checkout_intent: 'Order',
  return: 'Return',
  inventory_adjustment: 'Manual',
  admin_adjust: 'Manual',
  manual_adjustment: 'Manual',
  refurbishment_job: 'Refurbishment',
};

/**
 * @param {{ eventType: string; referenceType?: string | null }} row
 */
export function ledgerSourceLabel(row) {
  if (row.referenceType && LEDGER_SOURCE_BY_REF[row.referenceType]) {
    return LEDGER_SOURCE_BY_REF[row.referenceType];
  }
  return LEDGER_SOURCE_BY_EVENT[row.eventType] || 'Manual';
}

/**
 * @param {string | null | undefined} range
 * @param {string | null | undefined} from
 * @param {string | null | undefined} to
 */
function ledgerCreatedAtFilter(range, from, to) {
  const r = range == null || range === '' ? 'all' : String(range);
  if (r === 'all') return null;
  const now = new Date();
  if (r === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { gte: start };
  }
  if (r === 'custom') {
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
  const days = Number.parseInt(r, 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { gte: start };
}

/**
 * @param {string | null | undefined} source
 */
function eventTypesForSource(source) {
  const s = String(source || '');
  if (s === 'Order') return ['COMMIT', 'RESERVE', 'RELEASE'];
  if (s === 'Manual') return ['RESTOCK', 'ADJUST'];
  if (s === 'Return') return ['REFUND_RESTORE'];
  if (s === 'Refurbishment') return [];
  if (s === 'Transfer' || s === 'Stock count') return [];
  return null;
}

function referenceActorKey(referenceType, referenceId) {
  return `${referenceType}:${referenceId}`;
}

function serializeLedgerActor(user) {
  return {
    id: user.publicId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role?.name ?? null,
  };
}

/** Resolve customer/admin actors for ledger rows missing actorUserId (legacy order/checkout events). */
async function resolveReferenceActors(prisma, rows) {
  const refToUserId = new Map();
  const orderPublicIds = new Set();
  const intentReferenceIds = new Set();

  for (const row of rows) {
    if (row.actorUserId) continue;
    const { referenceType, referenceId } = row;
    if (!referenceType || !referenceId) continue;

    if (referenceType === 'order') {
      if (referenceId.startsWith('pending:')) {
        const userId = Number.parseInt(referenceId.slice('pending:'.length), 10);
        if (!Number.isNaN(userId)) {
          refToUserId.set(referenceActorKey(referenceType, referenceId), userId);
        }
      } else {
        orderPublicIds.add(referenceId);
      }
      continue;
    }

    if (referenceType === 'checkout_intent') {
      intentReferenceIds.add(referenceId);
    }
  }

  if (orderPublicIds.size > 0) {
    const orders = await prisma.order.findMany({
      where: { publicId: { in: [...orderPublicIds] } },
      select: { publicId: true, userId: true },
    });
    for (const order of orders) {
      if (order.userId) {
        refToUserId.set(referenceActorKey('order', order.publicId), order.userId);
      }
    }
  }

  if (intentReferenceIds.size > 0) {
    const refs = [...intentReferenceIds];
    const intents = await prisma.checkoutIntent.findMany({
      where: {
        OR: [{ publicId: { in: refs } }, { checkoutSignature: { in: refs } }],
      },
      select: { publicId: true, checkoutSignature: true, userId: true },
    });
    for (const intent of intents) {
      if (!intent.userId) continue;
      refToUserId.set(referenceActorKey('checkout_intent', intent.publicId), intent.userId);
      if (intent.checkoutSignature) {
        refToUserId.set(referenceActorKey('checkout_intent', intent.checkoutSignature), intent.userId);
      }
    }
  }

  const userIds = [...new Set([...refToUserId.values()].filter(Boolean))];
  if (!userIds.length) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      role: { select: { name: true } },
    },
  });
  const userById = new Map(users.map((user) => [user.id, user]));

  const refToActor = new Map();
  for (const [key, userId] of refToUserId) {
    const user = userById.get(userId);
    if (user) refToActor.set(key, serializeLedgerActor(user));
  }
  return refToActor;
}

export async function writeInventoryLedger(tx, {
  productId,
  productVariantId = null,
  quantityDelta,
  eventType,
  referenceType,
  referenceId,
  actorUserId = null,
  note = null,
}) {
  if (!productId || !eventType || !referenceType || !referenceId) return;
  await tx.inventoryLedgerEvent.create({
    data: {
      productId,
      productVariantId,
      quantityDelta,
      eventType,
      referenceType,
      referenceId,
      actorUserId,
      note,
    },
  });
}

export async function listLedgerHistory({
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
  const { prisma } = await import('../lib/prisma.js');
  const skip = (page - 1) * limit;
  const and = [];

  if (productPublicId) {
    const product = await prisma.product.findUnique({
      where: { publicId: productPublicId },
      select: { id: true },
    });
    if (!product) {
      return {
        entries: [],
        pagination: { total: 0, page, limit, pages: 1 },
        groupCounts: { all: 0, in: 0, out: 0, tr: 0, ret: 0, ref: 0, adj: 0 },
        facets: includeFacets ? { sources: [], locations: [], actors: [] } : undefined,
      };
    }
    and.push({ productId: product.id });
  } else if (productType === 'NEW' || productType === 'REFURBISHED') {
    and.push({ product: { productType } });
  }

  const createdAt = ledgerCreatedAtFilter(range, from, to);
  if (createdAt) and.push({ createdAt });

  const q = search ? String(search).trim() : '';
  if (q) {
    and.push({
      OR: [
        { product: { name: { contains: q, mode: 'insensitive' } } },
        { product: { sku: { contains: q, mode: 'insensitive' } } },
        { productVariant: { sku: { contains: q, mode: 'insensitive' } } },
        { note: { contains: q, mode: 'insensitive' } },
        { referenceId: { contains: q, mode: 'insensitive' } },
      ],
    });
  }

  const typeFilter = eventType && eventType !== 'all' ? String(eventType).toUpperCase() : null;
  if (typeFilter) {
    and.push({ eventType: typeFilter });
  }

  const srcFilter = source && source !== 'all' ? String(source) : null;
  if (srcFilter) {
    const types = eventTypesForSource(srcFilter);
    if (types && types.length === 0) {
      and.push({ id: -1 });
    } else if (types) {
      and.push({ eventType: { in: types } });
    }
  }

  const locFilter = location && location !== 'all' ? String(location).trim() : null;
  if (locFilter) {
    and.push({
      OR: [
        { productVariant: { warehouseLocation: locFilter } },
        {
          AND: [
            { productVariantId: null },
            { product: { warehouseLocation: locFilter } },
          ],
        },
      ],
    });
  }

  const actorFilter = actor && actor !== 'all' ? String(actor).trim() : null;
  if (actorFilter) {
    const actorUsers = await prisma.user.findMany({
      where: {
        OR: [
          { publicId: actorFilter },
          { email: { equals: actorFilter, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
      take: 5,
    });
    const actorIds = actorUsers.map((u) => u.id);
    if (!actorIds.length) {
      and.push({ id: -1 });
    } else {
      and.push({ actorUserId: { in: actorIds } });
    }
  }

  /** Base where for KPIs (everything except group). */
  const baseAnd = [...and];
  const grp = group && group !== 'all' ? String(group) : 'all';
  if (grp !== 'all') {
    const types = LEDGER_GROUP_TYPES[grp] || [];
    if (!types.length) {
      and.push({ id: -1 });
    } else {
      and.push({ eventType: { in: types } });
    }
  }

  const where = and.length ? { AND: and } : {};
  const baseWhere = baseAnd.length ? { AND: baseAnd } : {};

  const [rows, total, groupAgg] = await Promise.all([
    prisma.inventoryLedgerEvent.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        product: {
          select: {
            publicId: true,
            name: true,
            sku: true,
            imageUrl: true,
            warehouseLocation: true,
            stock: true,
          },
        },
        productVariant: {
          select: {
            publicId: true,
            sku: true,
            combination: true,
            warehouseLocation: true,
            stock: true,
          },
        },
      },
    }),
    prisma.inventoryLedgerEvent.count({ where }),
    prisma.inventoryLedgerEvent.groupBy({
      by: ['eventType'],
      where: baseWhere,
      _count: { _all: true },
    }),
  ]);

  const orderPublicIds = [
    ...new Set(
      rows
        .filter((r) => r.referenceType === 'order' && r.referenceId && !r.referenceId.startsWith('pending:'))
        .map((r) => r.referenceId)
    ),
  ];

  const checkoutRefIds = [
    ...new Set(
      rows.filter((r) => r.referenceType === 'checkout_intent' && r.referenceId).map((r) => r.referenceId)
    ),
  ];
  const checkoutIntents =
    checkoutRefIds.length > 0
      ? await prisma.checkoutIntent.findMany({
          where: {
            OR: [
              { publicId: { in: checkoutRefIds } },
              { checkoutSignature: { in: checkoutRefIds } },
            ],
          },
          select: { publicId: true, checkoutSignature: true, orderPublicId: true, status: true },
        })
      : [];
  const checkoutByRef = new Map();
  for (const intent of checkoutIntents) {
    checkoutByRef.set(intent.publicId, intent);
    if (intent.checkoutSignature) checkoutByRef.set(intent.checkoutSignature, intent);
  }

  const allOrderPublicIds = [
    ...new Set([
      ...orderPublicIds,
      ...checkoutIntents.map((i) => i.orderPublicId).filter(Boolean),
    ]),
  ];
  const orders =
    allOrderPublicIds.length > 0
      ? await prisma.order.findMany({
          where: { publicId: { in: allOrderPublicIds } },
          select: { publicId: true, orderNumber: true },
        })
      : [];
  const orderNumberByPublicId = new Map(orders.map((o) => [o.publicId, o.orderNumber]));

  const returnPublicIds = [
    ...new Set(
      rows.filter((r) => r.referenceType === 'return' && r.referenceId).map((r) => r.referenceId)
    ),
  ];
  const returnRows =
    returnPublicIds.length > 0
      ? await prisma.returnRequest.findMany({
          where: { publicId: { in: returnPublicIds } },
          select: { publicId: true, returnNumber: true, type: true },
        })
      : [];
  const returnMetaByPublicId = new Map(returnRows.map((rr) => [rr.publicId, rr]));

  const { formatOrderLedgerLabel, resolveLedgerNote } = await import('../lib/inventory-ledger-notes.js');

  const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter(Boolean))];
  const actors =
    actorIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: {
            id: true,
            publicId: true,
            email: true,
            firstName: true,
            lastName: true,
            role: { select: { name: true } },
          },
        })
      : [];
  const actorById = new Map(actors.map((actor) => [actor.id, actor]));
  const refActorByKey = await resolveReferenceActors(prisma, rows);

  const { combinationLabel } = await import('./inventory.service.js');

  /** Stock-after: current on-hand − sum of later deltas for same product/variant. */
  const stockKey = (productId, variantId) => `${productId}:${variantId ?? 'p'}`;
  const keysNeeded = new Map();
  for (const r of rows) {
    const key = stockKey(r.productId, r.productVariantId);
    if (!keysNeeded.has(key)) {
      keysNeeded.set(key, {
        productId: r.productId,
        productVariantId: r.productVariantId,
        current: r.productVariant ? r.productVariant.stock : r.product.stock,
        oldestAt: r.createdAt,
        oldestId: r.id,
      });
    } else {
      const cur = keysNeeded.get(key);
      if (
        r.createdAt < cur.oldestAt ||
        (r.createdAt.getTime() === cur.oldestAt.getTime() && r.id < cur.oldestId)
      ) {
        cur.oldestAt = r.createdAt;
        cur.oldestId = r.id;
      }
    }
  }

  /** @type {Map<string, number>} */
  const laterDeltaByRowId = new Map();
  await Promise.all(
    [...keysNeeded.values()].map(async (meta) => {
      const later = await prisma.inventoryLedgerEvent.findMany({
        where: {
          productId: meta.productId,
          productVariantId: meta.productVariantId ?? null,
          OR: [
            { createdAt: { gt: meta.oldestAt } },
            { AND: [{ createdAt: meta.oldestAt }, { id: { gte: meta.oldestId } }] },
          ],
        },
        select: { id: true, quantityDelta: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      let remaining = 0;
      for (const ev of later) {
        laterDeltaByRowId.set(ev.id, remaining);
        remaining += Number(ev.quantityDelta || 0);
      }
    })
  );

  const countByType = new Map(groupAgg.map((row) => [row.eventType, row._count._all]));
  const groupCounts = {
    all: [...countByType.values()].reduce((s, n) => s + n, 0),
    in: countByType.get('RESTOCK') || 0,
    out: countByType.get('COMMIT') || 0,
    tr: 0,
    ret: countByType.get('REFUND_RESTORE') || 0,
    ref: 0,
    adj: countByType.get('ADJUST') || 0,
  };

  let facets;
  if (includeFacets) {
    const facetRows = await prisma.inventoryLedgerEvent.findMany({
      where: baseWhere,
      select: {
        eventType: true,
        referenceType: true,
        actorUserId: true,
        product: { select: { warehouseLocation: true } },
        productVariant: { select: { warehouseLocation: true } },
      },
      take: 2000,
      orderBy: { createdAt: 'desc' },
    });
    const sources = new Set();
    const locations = new Set();
    const actorIdSet = new Set();
    for (const fr of facetRows) {
      sources.add(ledgerSourceLabel(fr));
      const loc = fr.productVariant?.warehouseLocation || fr.product?.warehouseLocation;
      if (loc) locations.add(loc);
      if (fr.actorUserId) actorIdSet.add(fr.actorUserId);
    }
    const facetActors =
      actorIdSet.size > 0
        ? await prisma.user.findMany({
            where: { id: { in: [...actorIdSet] } },
            select: {
              publicId: true,
              email: true,
              firstName: true,
              lastName: true,
            },
            orderBy: { email: 'asc' },
            take: 200,
          })
        : [];
    facets = {
      sources: [...sources].sort(),
      locations: [...locations].sort(),
      actors: facetActors.map((u) => ({
        id: u.publicId,
        label:
          [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || u.publicId,
        email: u.email,
      })),
    };
  }

  return {
    entries: rows.map((r) => {
      const actorRow = r.actorUserId ? actorById.get(r.actorUserId) : null;
      const actor =
        actorRow != null
          ? serializeLedgerActor(actorRow)
          : refActorByKey.get(referenceActorKey(r.referenceType, r.referenceId)) ?? null;
      const returnMeta =
        r.referenceType === 'return' && r.referenceId
          ? returnMetaByPublicId.get(r.referenceId)
          : null;
      const checkoutMeta =
        r.referenceType === 'checkout_intent' && r.referenceId
          ? checkoutByRef.get(r.referenceId) ?? null
          : null;
      const linkedCheckoutOrderPublicId = checkoutMeta?.orderPublicId ?? null;
      const orderNumber =
        r.referenceType === 'order' && r.referenceId && !r.referenceId.startsWith('pending:')
          ? orderNumberByPublicId.get(r.referenceId) ?? null
          : linkedCheckoutOrderPublicId
            ? orderNumberByPublicId.get(linkedCheckoutOrderPublicId) ?? null
            : null;
      const displayOrderNumber =
        orderNumber != null
          ? formatOrderLedgerLabel(
              orderNumber,
              r.referenceType === 'order' ? r.referenceId : linkedCheckoutOrderPublicId
            )
          : null;
      const refType =
        checkoutMeta?.orderPublicId && checkoutMeta.status === 'CONSUMED' ? 'order' : r.referenceType;
      const refId =
        checkoutMeta?.orderPublicId && checkoutMeta.status === 'CONSUMED'
          ? checkoutMeta.orderPublicId
          : r.referenceId;
      const laterDelta = laterDeltaByRowId.has(r.id) ? laterDeltaByRowId.get(r.id) : 0;
      const currentStock = r.productVariant ? r.productVariant.stock : r.product.stock;
      const stockAfter = Number(currentStock || 0) - Number(laterDelta || 0);
      const locationLabel =
        r.productVariant?.warehouseLocation || r.product.warehouseLocation || null;
      return {
        id: r.publicId,
        eventType: r.eventType,
        quantityDelta: r.quantityDelta,
        stockAfter,
        location: locationLabel,
        source: ledgerSourceLabel({ eventType: r.eventType, referenceType: refType }),
        referenceType: refType,
        referenceId: refId,
        referenceOrderNumber: displayOrderNumber,
        referenceCheckoutIntentId: checkoutMeta?.publicId ?? null,
        referenceReturnNumber: returnMeta?.returnNumber ?? null,
        referenceReturnType: returnMeta?.type ?? null,
        note: resolveLedgerNote(r, {
          orderNumber,
          orderPublicId: linkedCheckoutOrderPublicId,
          returnNumber: returnMeta?.returnNumber,
          returnType: returnMeta?.type,
        }),
        createdAt: r.createdAt,
        product: {
          id: r.product.publicId,
          name: r.product.name,
          sku: r.product.sku,
          imageUrl: r.product.imageUrl ?? null,
        },
        variant: r.productVariant
          ? {
              id: r.productVariant.publicId,
              sku: r.productVariant.sku,
              combinationLabel: combinationLabel(r.productVariant.combination),
            }
          : null,
        actor,
      };
    }),
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    },
    groupCounts,
    facets,
  };
}
