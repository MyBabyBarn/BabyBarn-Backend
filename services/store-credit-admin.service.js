import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { computeRefurbStoreCredit } from '../config/refurb.config.js';

const PENDING_RETURN_STATUSES = [
  'REQUESTED',
  'ELIGIBILITY_REVIEW',
  'APPROVED',
  'LABEL_GENERATED',
  'IN_TRANSIT',
  'RECEIVED',
  'UNDER_INSPECTION',
];

const STATUS_LABEL = {
  REQUESTED: 'Requested',
  ELIGIBILITY_REVIEW: 'Eligibility review',
  APPROVED: 'Approved',
  LABEL_GENERATED: 'Label ready',
  IN_TRANSIT: 'In transit',
  RECEIVED: 'Received',
  UNDER_INSPECTION: 'Under inspection',
  INSPECTION_APPROVED: 'Approved for credit',
  INSPECTION_REJECTED: 'Rejected',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

const LEDGER_TYPE_FILTER = {
  earned: 'EARNED',
  used: 'REDEEMED',
  redeemed: 'REDEEMED',
  adjustment: 'ADJUSTED',
  adjusted: 'ADJUSTED',
};

function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parsePage(raw) {
  const n = Number.parseInt(String(raw ?? '1'), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function parseLimit(raw, fallback = 50) {
  const n = Number.parseInt(String(raw ?? String(fallback)), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 100);
}

function estimateCreditFromReturn(row) {
  if (!row?.orderItem) return 0;
  if (row.orderItem.product?.productType === 'REFURBISHED') return 0;
  const unit = Number(row.orderItem.memberPriceSnapshot ?? row.orderItem.price ?? 0);
  const qty =
    row.acceptedQuantity != null
      ? Math.max(0, Number(row.acceptedQuantity))
      : Math.max(1, Number(row.quantity ?? 1));
  return money(computeRefurbStoreCredit(unit) * qty);
}

function mapMember(user) {
  if (!user) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email;
  return {
    id: user.publicId || String(user.id),
    name,
    email: user.email,
    accessNumber: user.accessNumber || null,
  };
}

function returnIdFromSourceKey(sourceKey) {
  const raw = String(sourceKey || '');
  const m = raw.match(/^earn:return:(.+)$/);
  return m ? m[1] : null;
}

function ledgerLabel(type) {
  switch (type) {
    case 'EARNED':
      return 'Credit awarded';
    case 'REDEEMED':
      return 'Used at checkout';
    case 'ADJUSTED':
      return 'Staff adjustment';
    case 'HOLD':
      return 'Held at checkout';
    case 'RELEASE':
      return 'Hold released';
    default: {
      const _exhaustive = type;
      void _exhaustive;
      return String(type || 'Entry');
    }
  }
}

const orderItemSelect = {
  price: true,
  memberPriceSnapshot: true,
  quantity: true,
  product: { select: { name: true, productType: true } },
};

const userSelect = {
  publicId: true,
  firstName: true,
  lastName: true,
  email: true,
  accessNumber: true,
};

async function computeStats() {
  const [wallets, earnedAgg, redeemedAgg, pendingReturns] = await Promise.all([
    prisma.storeCreditWallet.findMany({
      select: { balance: true, heldBalance: true },
    }),
    prisma.storeCreditTransaction.aggregate({
      where: { type: 'EARNED', amount: { gt: 0 } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.storeCreditTransaction.findMany({
      where: { type: 'REDEEMED' },
      select: { amount: true, orderPublicId: true },
    }),
    prisma.returnRequest.findMany({
      where: {
        type: 'REFURBISHMENT',
        status: { in: PENDING_RETURN_STATUSES },
      },
      select: {
        quantity: true,
        acceptedQuantity: true,
        orderItem: { select: orderItemSelect },
      },
    }),
  ]);

  const owed = money(wallets.reduce((s, w) => s + Math.max(0, Number(w.balance) || 0), 0));
  const reserved = money(wallets.reduce((s, w) => s + Math.max(0, Number(w.heldBalance) || 0), 0));
  const membersWithCredit = wallets.filter((w) => (Number(w.balance) || 0) > 0.004).length;

  const awarded = money(earnedAgg._sum.amount || 0);
  const awards = earnedAgg._count || 0;

  const used = money(redeemedAgg.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0));
  const usedOrders = new Set(redeemedAgg.map((t) => t.orderPublicId).filter(Boolean)).size;

  const waitingEstimate = money(
    pendingReturns.reduce((s, row) => s + estimateCreditFromReturn(row), 0)
  );

  return {
    owed,
    reserved,
    membersWithCredit,
    awarded,
    awards,
    used,
    usedOrders,
    waitingEstimate,
    waitingReturns: pendingReturns.length,
  };
}

async function fetchBalances({ search, quick, page, limit }) {
  const where = {};
  if (quick === 'has' || quick === 'pos') {
    where.balance = { gt: 0.004 };
  } else if (quick === 'zero') {
    where.balance = { lte: 0.004 };
  }

  if (search) {
    const q = search.trim();
    where.user = {
      OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { accessNumber: { contains: q, mode: 'insensitive' } },
      ],
    };
  }

  const [total, rows, hasCount, zeroCount] = await Promise.all([
    prisma.storeCreditWallet.count({ where }),
    prisma.storeCreditWallet.findMany({
      where,
      include: {
        user: { select: userSelect },
        _count: { select: { transactions: true } },
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
      orderBy: [{ balance: 'desc' }, { updatedAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.storeCreditWallet.count({ where: { balance: { gt: 0.004 } } }),
    prisma.storeCreditWallet.count({ where: { balance: { lte: 0.004 } } }),
  ]);

  return {
    items: rows.map((w) => ({
      id: w.publicId || String(w.id),
      member: mapMember(w.user),
      balance: money(w.balance),
      reserved: money(w.heldBalance),
      entries: w._count.transactions,
      lastActivityAt: w.transactions[0]?.createdAt || w.updatedAt,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    quickCounts: {
      has: hasCount,
      zero: zeroCount,
    },
  };
}

async function fetchLedger({ search, type, page, limit }) {
  const where = {};
  const mapped = LEDGER_TYPE_FILTER[String(type || '').toLowerCase()];
  if (mapped) {
    where.type = mapped;
  } else if (type && type !== 'all') {
    const upper = String(type).toUpperCase();
    if (['EARNED', 'REDEEMED', 'ADJUSTED', 'HOLD', 'RELEASE'].includes(upper)) {
      where.type = upper;
    }
  }

  if (search) {
    const q = search.trim();
    where.OR = [
      { note: { contains: q, mode: 'insensitive' } },
      { orderPublicId: { contains: q, mode: 'insensitive' } },
      { sourceKey: { contains: q, mode: 'insensitive' } },
      { publicId: { contains: q, mode: 'insensitive' } },
      {
        wallet: {
          user: {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { accessNumber: { contains: q, mode: 'insensitive' } },
            ],
          },
        },
      },
    ];
  }

  const [total, rows, typeGroups, allCount] = await Promise.all([
    prisma.storeCreditTransaction.count({ where }),
    prisma.storeCreditTransaction.findMany({
      where,
      include: {
        wallet: {
          include: {
            user: { select: userSelect },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.storeCreditTransaction.groupBy({
      by: ['type'],
      _count: true,
    }),
    prisma.storeCreditTransaction.count(),
  ]);

  const typeCounts = { EARNED: 0, REDEEMED: 0, ADJUSTED: 0, HOLD: 0, RELEASE: 0 };
  for (const g of typeGroups) {
    typeCounts[g.type] = g._count;
  }

  return {
    items: rows.map((t) => {
      const returnPublicId = returnIdFromSourceKey(t.sourceKey);
      return {
        id: t.publicId || String(t.id),
        type: t.type,
        typeLabel: ledgerLabel(t.type),
        amount: money(t.amount),
        absoluteAmount: money(Math.abs(Number(t.amount) || 0)),
        note: t.note,
        orderPublicId: t.orderPublicId,
        returnPublicId,
        createdAt: t.createdAt,
        member: mapMember(t.wallet?.user),
        by: t.type === 'ADJUSTED' ? 'Administrator' : 'System',
      };
    }),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    typeCounts,
    ledgerTotal: allCount,
  };
}

async function fetchPending({ search, page, limit }) {
  const where = {
    type: 'REFURBISHMENT',
    status: { in: PENDING_RETURN_STATUSES },
  };
  if (search) {
    const q = search.trim();
    where.OR = [
      { publicId: { contains: q, mode: 'insensitive' } },
      { returnNumber: { contains: q, mode: 'insensitive' } },
      { submissionPublicId: { contains: q, mode: 'insensitive' } },
      {
        user: {
          OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { accessNumber: { contains: q, mode: 'insensitive' } },
          ],
        },
      },
      {
        order: {
          OR: [
            { publicId: { contains: q, mode: 'insensitive' } },
            { orderNumber: { contains: q, mode: 'insensitive' } },
          ],
        },
      },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.returnRequest.count({ where }),
    prisma.returnRequest.findMany({
      where,
      include: {
        user: { select: userSelect },
        order: { select: { publicId: true, orderNumber: true } },
        orderItem: { select: orderItemSelect },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.publicId,
      returnNumber: r.returnNumber,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] || r.status,
      createdAt: r.createdAt,
      member: mapMember(r.user),
      orderPublicId: r.order?.publicId || null,
      orderNumber: r.order?.orderNumber || null,
      estimate: estimateCreditFromReturn(r),
      productName: r.orderItem?.product?.name || null,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

/**
 * Store credit admin overview — Balances / Ledger / Waiting for inspection.
 */
export async function fetchStoreCreditOverview(query = {}) {
  const tabRaw = String(query.tab || 'balances').toLowerCase();
  const tab =
    tabRaw === 'led' || tabRaw === 'ledger'
      ? 'ledger'
      : tabRaw === 'pen' || tabRaw === 'waiting' || tabRaw === 'pending'
        ? 'waiting'
        : 'balances';
  const page = parsePage(query.page);
  const limit = parseLimit(query.limit, 50);
  const search = query.search ? String(query.search).trim() : query.q ? String(query.q).trim() : '';
  const quick = query.quick ? String(query.quick).toLowerCase() : query.qk ? String(query.qk).toLowerCase() : '';
  const type = query.type ? String(query.type).toLowerCase() : 'all';

  const [stats, balancesWithCredit, ledgerCount, waitingCount] = await Promise.all([
    computeStats(),
    prisma.storeCreditWallet.count({ where: { balance: { gt: 0.004 } } }),
    prisma.storeCreditTransaction.count(),
    prisma.returnRequest.count({
      where: {
        type: 'REFURBISHMENT',
        status: { in: PENDING_RETURN_STATUSES },
      },
    }),
  ]);

  const tabCounts = {
    balances: balancesWithCredit,
    ledger: ledgerCount,
    waiting: waitingCount,
  };

  if (tab === 'ledger') {
    const data = await fetchLedger({ search, type, page, limit });
    return { tab, stats, tabCounts, ...data };
  }
  if (tab === 'waiting') {
    const data = await fetchPending({ search, page, limit });
    return { tab, stats, tabCounts, ...data };
  }

  const data = await fetchBalances({ search, quick, page, limit });
  return { tab, stats, tabCounts, ...data };
}

/** @deprecated Prefer fetchStoreCreditOverview — kept for older clients. */
export async function fetchStoreCreditActivity() {
  const overview = await fetchStoreCreditOverview({ tab: 'waiting', limit: 100 });
  return {
    items: (overview.items || []).map((r) => ({
      id: r.id,
      customer: r.member?.name || '—',
      email: r.member?.email || '',
      amount: r.estimate,
      status: r.statusLabel,
      createdAt: r.createdAt,
    })),
  };
}

export async function adjustStoreCreditAdmin() {
  throw new AppError(
    501,
    'Staff credit adjustment is recorded in policy but launch status and limits are not decided.',
    'STORE_CREDIT_ADJUST_NOT_LAUNCHED'
  );
}
