import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { AppError } from '../utils/error-handler.js';
import {
  normalizeTeamPermissionModules,
  normalizeTeamAccessPayload,
} from '../constants/admin-modules.js';
import { serializeAdminAccess } from '../constants/admin-actions.js';
import { emailService } from './email.service.js';
import { writeAdminAudit } from './audit.service.js';
import { config } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { PORTAL_SCOPE, findUserByEmailAndPortal, rehomeMisScopedStaffToStaffPortal } from '../lib/portal-scope.js';
import {
  buildLegacyAdminPendingCountWhere,
  buildPaymentPendingWhere,
  buildToFulfillWhere,
  buildPickupReadyWhere,
  buildShippedWhere,
} from '../lib/order-query-filters.js';
import {
  CUSTOMER_CANCEL_WINDOW_MS,
  canCustomerCancelOrder,
  customerCancelWindowEndsAt,
} from '../lib/customer-order-cancellation.js';
import { hashAuthToken } from '../lib/auth-token-hash.js';

function isStorefrontCustomerRole(roleName) {
  return roleName === 'CUSTOMER' || roleName === 'USER';
}

function dateRangeWhere(dateFrom, dateTo) {
  const range = {};
  if (dateFrom) range.gte = new Date(dateFrom);
  if (dateTo) {
    const e = new Date(dateTo);
    e.setHours(23, 59, 59, 999);
    range.lte = e;
  }
  return Object.keys(range).length ? range : undefined;
}

const MS_DAY = 24 * 60 * 60 * 1000;

export async function getFinanceStats({ dateFrom, dateTo } = {}) {
  const createdAt = dateRangeWhere(dateFrom, dateTo);
  const basePaid = {
    paymentStatus: 'PAID',
    status: { notIn: ['CANCELLED'] },
    ...(createdAt ? { createdAt } : {}),
  };

  const creditTxnRange = createdAt
    ? { createdAt }
    : undefined;

  const [
    totalAgg,
    refundedAgg,
    refurbishedRow,
    newProductRow,
    refurbishedOrderCount,
    newProductOrderCount,
    taxShipAgg,
    storeCreditOwedAgg,
    creditIssuedAgg,
    creditUsedAgg,
    creditAdjAgg,
  ] = await Promise.all([
      prisma.order.aggregate({
        where: basePaid,
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.order.aggregate({
        where: {
          paymentStatus: 'REFUNDED',
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { totalAmount: true },
        _count: true,
      }),
      refurbishedSalesRaw(createdAt),
      newProductSalesRaw(createdAt),
      distinctOrderCountByProductType(createdAt, 'REFURBISHED'),
      distinctOrderCountByProductType(createdAt, 'NEW'),
      prisma.order.aggregate({
        where: basePaid,
        _sum: { taxAmount: true, shippingCost: true },
      }),
      prisma.storeCreditWallet.aggregate({
        _sum: { balance: true },
      }),
      prisma.storeCreditTransaction.aggregate({
        where: { type: 'EARNED', ...(creditTxnRange || {}) },
        _sum: { amount: true },
      }),
      prisma.storeCreditTransaction.aggregate({
        where: { type: 'REDEEMED', ...(creditTxnRange || {}) },
        _sum: { amount: true },
      }),
      prisma.storeCreditTransaction.aggregate({
        where: { type: 'ADJUSTED', ...(creditTxnRange || {}) },
        _sum: { amount: true },
      }),
    ]);

  const now = new Date();
  const activeMembers = await prisma.user.count({
    where: {
      accessMemberUntil: { gt: now },
    },
  });

  const { getMembershipRevenueStats } = await import('./membership.service.js');
  const membershipStats = await getMembershipRevenueStats({ dateFrom, dateTo });

  const totalRevenue = totalAgg._sum.totalAmount ?? 0;
  const refundedTotal = refundedAgg._sum.totalAmount ?? 0;
  const taxCollected = Number(taxShipAgg._sum.taxAmount || 0);
  const shippingCharged = Number(taxShipAgg._sum.shippingCost || 0);
  const storeCreditOwed = Math.max(0, Number(storeCreditOwedAgg._sum.balance || 0));
  const storeCreditIssued = Math.max(0, Number(creditIssuedAgg._sum.amount || 0));
  const storeCreditUsed = Math.abs(Number(creditUsedAgg._sum.amount || 0));
  const storeCreditAdjusted = Number(creditAdjAgg._sum.amount || 0);

  // Money-in series for overview chart (daily buckets over the selected window, max 90 points).
  const seriesEnd = createdAt?.lte ? new Date(createdAt.lte) : now;
  const seriesStart = createdAt?.gte
    ? new Date(createdAt.gte)
    : new Date(seriesEnd.getTime() - 30 * MS_DAY);
  const spanDays = Math.max(
    1,
    Math.min(90, Math.ceil((seriesEnd.getTime() - seriesStart.getTime()) / MS_DAY))
  );
  const step = spanDays > 45 ? 7 : 1;
  const seriesBuckets = [];
  for (let t = seriesStart.getTime(); t <= seriesEnd.getTime(); t += step * MS_DAY) {
    seriesBuckets.push({
      start: new Date(t),
      end: new Date(Math.min(seriesEnd.getTime() + 1, t + step * MS_DAY)),
    });
  }
  const moneyInSeries = await Promise.all(
    seriesBuckets.map(async (b) => {
      const [ord, mem] = await Promise.all([
        prisma.order.aggregate({
          where: {
            paymentStatus: 'PAID',
            status: { notIn: ['CANCELLED'] },
            createdAt: { gte: b.start, lt: b.end },
          },
          _sum: { totalAmount: true },
        }),
        prisma.membershipPayment.aggregate({
          where: { paidAt: { gte: b.start, lt: b.end } },
          _sum: { amount: true },
        }),
      ]);
      return {
        label: b.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        amount: Number(ord._sum.totalAmount || 0) + Number(mem._sum.amount || 0),
      };
    })
  );

  // Tax by calendar month (ignores period filter — prototype tax tab behavior).
  const taxOrders = await prisma.order.findMany({
    where: {
      paymentStatus: { in: ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
      status: { not: 'CANCELLED' },
    },
    select: { createdAt: true, taxAmount: true, totalAmount: true, paymentStatus: true },
    take: 5000,
    orderBy: { createdAt: 'desc' },
  });
  const taxByMonthMap = new Map();
  for (const o of taxOrders) {
    const key = o.createdAt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const row = taxByMonthMap.get(key) || { month: key, ts: o.createdAt.getTime(), taxableSales: 0, taxCollected: 0, taxRefunded: 0 };
    if (o.paymentStatus === 'PAID') {
      row.taxableSales += Number(o.totalAmount || 0) - Number(o.taxAmount || 0);
      row.taxCollected += Number(o.taxAmount || 0);
    } else {
      row.taxRefunded += Number(o.taxAmount || 0);
    }
    taxByMonthMap.set(key, row);
  }
  const taxByMonth = [...taxByMonthMap.values()]
    .sort((a, b) => b.ts - a.ts)
    .map(({ ts: _ts, ...rest }) => ({
      ...rest,
      taxableSales: +rest.taxableSales.toFixed(2),
      taxCollected: +rest.taxCollected.toFixed(2),
      taxRefunded: +rest.taxRefunded.toFixed(2),
      netTaxOwed: +(rest.taxCollected - rest.taxRefunded).toFixed(2),
    }));

  return {
    totalRevenue,
    paidOrderCount: totalAgg._count,
    refurbishedSales: refurbishedRow,
    newProductSales: newProductRow,
    refurbishedOrderCount,
    newProductOrderCount,
    netRevenue: Math.max(0, totalRevenue - refundedTotal),
    refundedTotal,
    refundedOrderCount: refundedAgg._count,
    membershipRevenueInOrders: membershipStats.membershipRevenue,
    membershipPaymentCount: membershipStats.membershipPaymentCount,
    membershipNote:
      'Farmhouse Friends revenue is tracked in the membership payment ledger (Stripe Checkout).',
    activeMembersCount: activeMembers,
    taxCollected: +taxCollected.toFixed(2),
    shippingCharged: +shippingCharged.toFixed(2),
    storeCreditOwed: +storeCreditOwed.toFixed(2),
    storeCreditIssued: +storeCreditIssued.toFixed(2),
    storeCreditUsed: +storeCreditUsed.toFixed(2),
    storeCreditAdjusted: +storeCreditAdjusted.toFixed(2),
    moneyInSeries,
    taxByMonth,
  };
}

function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayBuckets(n, end = startOfLocalDay()) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const start = new Date(end.getTime() - i * MS_DAY);
    out.push({ start, end: new Date(start.getTime() + MS_DAY) });
  }
  return out;
}

function ageLabel(ts, now = Date.now()) {
  const m = Math.max(1, Math.round((now - new Date(ts).getTime()) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 2880) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} days`;
}

/**
 * Admin dashboard — prototype parity (doc 49 / HTML dbView).
 * Legacy top-level KPI fields kept for older clients; `panels` drives the new UI.
 */
export async function getDashboardOverview(actor = null, { range = '7' } = {}) {
  const now = new Date();
  const nowMs = now.getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const todayStart = startOfLocalDay(now);
  const rangeDays = range === '1' ? 1 : range === '30' ? 30 : 7;
  const periodStart = new Date(nowMs - rangeDays * MS_DAY);
  const prevPeriodStart = new Date(periodStart.getTime() - rangeDays * MS_DAY);
  const endSoonUntil = new Date(nowMs + 14 * MS_DAY);
  const end30Until = new Date(nowMs + 30 * MS_DAY);
  const cancelWindowFloor = new Date(nowMs - CUSTOMER_CANCEL_WINDOW_MS);
  const chartDays = rangeDays >= 30 ? 30 : 14;
  const inspectionInStatuses = ['RECEIVED', 'UNDER_INSPECTION'];
  const stdRequested = ['REQUESTED'];
  const refRequested = ['REQUESTED', 'ELIGIBILITY_REVIEW'];

  const { productService } = await import('./product.service.js');
  const { inventoryService } = await import('./inventory.service.js');
  const { canAccessRouteModule } = await import('../constants/admin-modules.js');
  const { listAuditLogs } = await import('./audit.service.js');

  const role = actor?.role;
  const modules = actor?.adminModules;
  const isAdmin = role === 'ADMIN';
  const can = (routeModule) =>
    isAdmin || canAccessRouteModule(Array.isArray(modules) ? modules : [], routeModule);

  const wantProducts = can('products') || can('refurbished');
  const wantOrders = can('orders');
  const wantInventory = can('inventory');
  const wantCustomers = can('customers');
  const wantAccess = can('access');
  const wantReturns = can('returns');
  const wantInspection = can('inspection') || wantReturns;
  const wantBlog = can('blog');
  const wantCarousel = can('homepage');
  const wantReviews = can('reviews');
  const wantActivity = can('activity') || isAdmin;

  const paidReceivedWhere = {
    paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
    status: { not: 'CANCELLED' },
  };

  const [
    newProductStats,
    refurbishedStats,
    inventoryStats,
    totalOrdersAll,
    legacyPendingOrders,
    ordersThisMonth,
    registeredCustomers,
    activeMembers,
    membersEndingSoon,
    membersEnded,
    pendingInspections,
    queuedInspectionsToday,
    paymentPending,
    toFulfill,
    pickupReady,
    pickupReadyNoLabel,
    shippedOnWay,
    cancellationRequests,
    ordersInPeriod,
    ordersPrevPeriod,
    stdRequestedCount,
    stdInCount,
    refRequestedCount,
    refInCount,
    pendingReturnsCombined,
    chartOrders,
    cancelCandidates,
    stockRiskProducts,
    blogScheduled,
    blogPublished,
    slidesActive,
    slidesTotal,
    reviewsWeek,
    reviewsLowStars,
    recentLogs,
    oldestToFulfill,
    oldestNoLabel,
    oldestCancelReq,
    oldestReturnIn,
  ] = await Promise.all([
    wantProducts ? productService.getAdminProductStats('NEW') : Promise.resolve({ total: null }),
    wantProducts || can('refurbished')
      ? productService.getAdminProductStats('REFURBISHED')
      : Promise.resolve({ total: null }),
    wantInventory ? inventoryService.getStats() : Promise.resolve({ criticalUnderThreshold: null, outOfStock: null }),
    wantOrders
      ? prisma.order.count({ where: paidReceivedWhere })
      : Promise.resolve(null),
    wantOrders
      ? prisma.order.count({ where: buildLegacyAdminPendingCountWhere() })
      : Promise.resolve(null),
    wantOrders
      ? prisma.order.count({ where: { createdAt: { gte: monthStart } } })
      : Promise.resolve(null),
    wantCustomers
      ? prisma.user.count({
          where: {
            isGuest: false,
            role: { name: { in: ['CUSTOMER', 'USER'] } },
          },
        })
      : Promise.resolve(null),
    wantAccess
      ? prisma.user.count({ where: { accessMemberUntil: { gt: now }, isGuest: false } })
      : Promise.resolve(null),
    wantAccess
      ? prisma.user.count({
          where: {
            isGuest: false,
            accessMemberUntil: { gt: now, lte: endSoonUntil },
          },
        })
      : Promise.resolve(null),
    wantAccess
      ? prisma.user.count({
          where: {
            isGuest: false,
            accessMemberUntil: { not: null, lte: now },
          },
        })
      : Promise.resolve(null),
    wantInspection
      ? prisma.returnRequest.count({
          where: { type: 'REFURBISHMENT', status: { in: inspectionInStatuses } },
        })
      : Promise.resolve(null),
    wantInspection
      ? prisma.returnRequest.count({
          where: { status: 'UNDER_INSPECTION', updatedAt: { gte: todayStart } },
        })
      : Promise.resolve(null),
    wantOrders ? prisma.order.count({ where: buildPaymentPendingWhere() }) : Promise.resolve(null),
    wantOrders ? prisma.order.count({ where: buildToFulfillWhere() }) : Promise.resolve(null),
    wantOrders ? prisma.order.count({ where: buildPickupReadyWhere() }) : Promise.resolve(null),
    wantOrders
      ? prisma.order.count({
          where: {
            AND: [buildPickupReadyWhere(), { trackingNumber: null }, { labelGeneratedAt: null }],
          },
        })
      : Promise.resolve(null),
    wantOrders ? prisma.order.count({ where: buildShippedWhere() }) : Promise.resolve(null),
    wantOrders
      ? prisma.order.count({ where: { cancellationReviewStatus: 'PENDING' } })
      : Promise.resolve(null),
    wantOrders
      ? prisma.order.count({
          where: { ...paidReceivedWhere, createdAt: { gte: periodStart } },
        })
      : Promise.resolve(null),
    wantOrders
      ? prisma.order.count({
          where: {
            ...paidReceivedWhere,
            createdAt: { gte: prevPeriodStart, lt: periodStart },
          },
        })
      : Promise.resolve(null),
    wantReturns
      ? prisma.returnRequest.count({
          where: { type: 'STANDARD', status: { in: stdRequested } },
        })
      : Promise.resolve(null),
    wantReturns
      ? prisma.returnRequest.count({
          where: { type: 'STANDARD', status: { in: inspectionInStatuses } },
        })
      : Promise.resolve(null),
    wantInspection
      ? prisma.returnRequest.count({
          where: { type: 'REFURBISHMENT', status: { in: refRequested } },
        })
      : Promise.resolve(null),
    wantInspection
      ? prisma.returnRequest.count({
          where: { type: 'REFURBISHMENT', status: { in: inspectionInStatuses } },
        })
      : Promise.resolve(null),
    wantInspection
      ? prisma.returnRequest.count({
          where: {
            status: { in: inspectionInStatuses },
            type: { in: ['STANDARD', 'REFURBISHMENT'] },
          },
        })
      : Promise.resolve(null),
    wantOrders
      ? prisma.order.findMany({
          where: {
            ...paidReceivedWhere,
            createdAt: { gte: new Date(todayStart.getTime() - (chartDays - 1) * MS_DAY) },
          },
          select: { createdAt: true },
        })
      : Promise.resolve([]),
    wantOrders
      ? prisma.order.findMany({
          where: {
            paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
            status: { notIn: ['CANCELLED', 'REFUNDED', 'RETURNED', 'SHIPPED', 'DELIVERED'] },
            fulfillmentStatus: 'ACCEPTED',
            OR: [
              { fulfillmentAcceptedAt: { gte: cancelWindowFloor } },
              { fulfillmentAcceptedAt: null, createdAt: { gte: cancelWindowFloor } },
            ],
          },
          select: {
            id: true,
            publicId: true,
            orderNumber: true,
            status: true,
            paymentStatus: true,
            fulfillmentStatus: true,
            fulfillmentAcceptedAt: true,
            createdAt: true,
            deliveredAt: true,
            cancellationReviewStatus: true,
            user: { select: { firstName: true, lastName: true, email: true } },
            orderItems: { select: { cancelledAt: true } },
          },
          orderBy: { fulfillmentAcceptedAt: 'asc' },
          take: 40,
        })
      : Promise.resolve([]),
    wantInventory
      ? prisma.product.findMany({
          where: { isDraft: false },
          select: {
            name: true,
            publicId: true,
            reorderPoint: true,
            variants: {
              select: { sku: true, stock: true, reservedStock: true, combination: true },
              orderBy: { sortOrder: 'asc' },
            },
          },
          take: 200,
        })
      : Promise.resolve([]),
    wantBlog
      ? prisma.blogPost.count({ where: { status: 'SCHEDULED', deletedAt: null } })
      : Promise.resolve(null),
    wantBlog
      ? prisma.blogPost.count({ where: { status: 'PUBLISHED', deletedAt: null } })
      : Promise.resolve(null),
    wantCarousel
      ? prisma.homepageCarouselSlide.count({ where: { isActive: true } })
      : Promise.resolve(null),
    wantCarousel ? prisma.homepageCarouselSlide.count() : Promise.resolve(null),
    wantReviews
      ? prisma.productReview.count({
          where: {
            deletedAt: null,
            createdAt: { gte: new Date(nowMs - 7 * MS_DAY) },
          },
        })
      : Promise.resolve(null),
    wantReviews
      ? prisma.productReview.count({
          where: {
            deletedAt: null,
            status: 'APPROVED',
            rating: { lte: 2 },
          },
        })
      : Promise.resolve(null),
    wantActivity
      ? listAuditLogs(1, 6, {}).catch(() => ({ logs: [] }))
      : Promise.resolve({ logs: [] }),
    wantOrders
      ? prisma.order.findFirst({
          where: buildToFulfillWhere(),
          orderBy: [{ fulfillmentAcceptedAt: 'asc' }, { createdAt: 'asc' }],
          select: { fulfillmentAcceptedAt: true, createdAt: true },
        })
      : Promise.resolve(null),
    wantOrders
      ? prisma.order.findFirst({
          where: {
            AND: [buildPickupReadyWhere(), { trackingNumber: null }, { labelGeneratedAt: null }],
          },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        })
      : Promise.resolve(null),
    wantOrders
      ? prisma.order.findFirst({
          where: { cancellationReviewStatus: 'PENDING' },
          orderBy: { updatedAt: 'asc' },
          select: { updatedAt: true, createdAt: true },
        })
      : Promise.resolve(null),
    wantInspection
      ? prisma.returnRequest.findFirst({
          where: { status: { in: inspectionInStatuses } },
          orderBy: { updatedAt: 'asc' },
          select: { updatedAt: true, createdAt: true },
        })
      : Promise.resolve(null),
  ]);

  const cancelWindows = (cancelCandidates || [])
    .filter((o) => canCustomerCancelOrder(o, nowMs))
    .map((o) => {
      const endsAt = customerCancelWindowEndsAt(o);
      const name = [o.user?.firstName, o.user?.lastName].filter(Boolean).join(' ') || o.user?.email || 'Customer';
      return {
        id: o.publicId || String(o.id),
        orderNumber: o.orderNumber || null,
        customerName: name,
        endsAt: endsAt ? endsAt.toISOString() : null,
      };
    })
    .sort((a, b) => new Date(a.endsAt || 0).getTime() - new Date(b.endsAt || 0).getTime())
    .slice(0, 5);

  const buckets = dayBuckets(chartDays, todayStart);
  const ordersPerDay = buckets.map(({ start, end }) => {
    const count = (chartOrders || []).filter((o) => {
      const t = new Date(o.createdAt).getTime();
      return t >= start.getTime() && t < end.getTime();
    }).length;
    return { date: start.toISOString().slice(0, 10), count };
  });

  let membersEndingByDay = null;
  if (wantAccess) {
    const endingMembers = await prisma.user.findMany({
      where: {
        isGuest: false,
        accessMemberUntil: { gt: now, lte: end30Until },
      },
      select: { accessMemberUntil: true },
    });
    const endBuckets = dayBuckets(30, todayStart);
    membersEndingByDay = endBuckets.map(({ start, end }) =>
      endingMembers.filter((m) => {
        const t = new Date(m.accessMemberUntil).getTime();
        return t >= start.getTime() && t < end.getTime();
      }).length
    );
  }

  const stockRisk = [];
  if (wantInventory && Array.isArray(stockRiskProducts)) {
    for (const p of stockRiskProducts) {
      const threshold = Number(p.reorderPoint) > 0 ? Number(p.reorderPoint) : 10;
      for (const v of p.variants || []) {
        const available = Math.max(0, Number(v.stock || 0) - Number(v.reservedStock || 0));
        const combo =
          v.combination && typeof v.combination === 'object'
            ? Object.values(v.combination).filter(Boolean).join(' · ')
            : '';
        let kind = null;
        if (available <= 0) kind = 'out';
        else if (available < 3) kind = 'nobuy';
        else if (available <= threshold) kind = 'low';
        if (!kind) continue;
        stockRisk.push({
          productName: p.name,
          sku: v.sku,
          detail: combo || null,
          available,
          threshold,
          kind,
          hrefId: p.publicId,
        });
      }
    }
    stockRisk.sort((a, b) => a.available - b.available);
  }

  const outOrNobuy = stockRisk.filter((l) => l.kind === 'out' || l.kind === 'nobuy').length;
  const lowOnly = stockRisk.filter((l) => l.kind === 'low').length;
  const lowStockCount = wantInventory
    ? Number(inventoryStats.criticalUnderThreshold || 0) + Number(inventoryStats.outOfStock || 0)
    : null;

  const needsAction = [];
  if (wantOrders && cancellationRequests > 0) {
    needsAction.push({
      key: 'cxr',
      count: cancellationRequests,
      label: 'Cancellation requests',
      detail: oldestCancelReq
        ? `oldest ${ageLabel(oldestCancelReq.updatedAt || oldestCancelReq.createdAt, nowMs)}`
        : null,
      href: '/admin/orders?cancellationReviewStatus=PENDING',
    });
  }
  if (wantOrders && toFulfill > 0) {
    needsAction.push({
      key: 'unas',
      count: toFulfill,
      label: 'Orders to fulfil',
      detail: oldestToFulfill
        ? `oldest ${ageLabel(oldestToFulfill.fulfillmentAcceptedAt || oldestToFulfill.createdAt, nowMs)}`
        : null,
      href: '/admin/orders?statusGroup=to_fulfill',
    });
  }
  if (wantOrders && pickupReadyNoLabel > 0) {
    needsAction.push({
      key: 'lab',
      count: pickupReadyNoLabel,
      label: 'Ready to ship, no label yet',
      detail: oldestNoLabel ? `oldest ${ageLabel(oldestNoLabel.createdAt, nowMs)}` : null,
      href: '/admin/orders?statusGroup=pickup_ready',
    });
  }
  if (wantInspection && pendingReturnsCombined > 0) {
    needsAction.push({
      key: 'ret',
      count: pendingReturnsCombined,
      label: 'Returns received or under inspection',
      detail: oldestReturnIn
        ? `oldest ${ageLabel(oldestReturnIn.updatedAt || oldestReturnIn.createdAt, nowMs)}`
        : null,
      href: '/admin/returns',
    });
  }
  if (wantInventory && (outOrNobuy + lowOnly) > 0) {
    needsAction.push({
      key: 'stk',
      count: outOrNobuy + lowOnly,
      label: 'Stock lines out or low',
      detail: null,
      href: '/admin/inventory?stockStatus=low_stock',
    });
  }

  const periodDeltaPct =
    wantOrders && ordersPrevPeriod > 0
      ? Math.round(((ordersInPeriod - ordersPrevPeriod) / ordersPrevPeriod) * 100)
      : null;

  const spark = ordersPerDay.slice(-14).map((d) => d.count);

  return {
    range: String(rangeDays),
    generatedAt: now.toISOString(),
    // Legacy flat KPIs (module-gated nulls)
    totalProductsNew: wantProducts
      ? newProductStats.activeListings ?? newProductStats.total
      : null,
    totalRefurbished:
      wantProducts || can('refurbished')
        ? refurbishedStats.activeListings ?? refurbishedStats.total
        : null,
    totalOrders: wantOrders ? totalOrdersAll : null,
    pendingOrders: wantOrders ? toFulfill : null,
    pendingFulfillment: wantOrders ? toFulfill : null,
    ordersThisMonth: wantOrders ? ordersThisMonth : null,
    registeredCustomers: wantCustomers ? registeredCustomers : null,
    activeMembers: wantAccess ? activeMembers : null,
    pendingInspections: wantInspection ? pendingInspections : null,
    queuedInspectionsToday: wantInspection ? queuedInspectionsToday : null,
    lowStockCount,
    panels: {
      needsAction,
      tiles: {
        registeredCustomers,
        activeMembers,
        membersEndingSoon: wantAccess ? membersEndingSoon : null,
        newProducts: wantProducts
          ? newProductStats.activeListings ?? newProductStats.total
          : null,
        refurbishedProducts:
          wantProducts || can('refurbished')
            ? refurbishedStats.activeListings ?? refurbishedStats.total
            : null,
        totalOrders: wantOrders ? totalOrdersAll : null,
        ordersInPeriod: wantOrders ? ordersInPeriod : null,
        ordersPrevPeriod: wantOrders ? ordersPrevPeriod : null,
        periodDeltaPct,
        spark: wantOrders ? spark : null,
        pendingOrders: wantOrders ? toFulfill : null,
        pendingReturns: wantInspection ? pendingReturnsCombined : null,
        pendingReturnsStandard: wantReturns ? stdInCount : null,
        pendingReturnsRefurb: wantInspection ? refInCount : null,
        oldestPendingAge:
          wantOrders && oldestToFulfill
            ? ageLabel(oldestToFulfill.fulfillmentAcceptedAt || oldestToFulfill.createdAt, nowMs)
            : null,
      },
      orderFlow: wantOrders
        ? {
            paymentPending,
            toFulfill,
            readyToShip: pickupReady,
            readyNoLabel: pickupReadyNoLabel,
            readyWithLabel: Math.max(0, (pickupReady || 0) - (pickupReadyNoLabel || 0)),
            shipped: shippedOnWay,
          }
        : null,
      cancelWindows: wantOrders
        ? { total: cancelWindows.length, items: cancelWindows }
        : null,
      ordersPerDay: wantOrders ? { days: chartDays, points: ordersPerDay } : null,
      stockRisk: wantInventory
        ? {
            outOrNotBuyable: outOrNobuy,
            low: lowOnly,
            lines: stockRisk.slice(0, 7),
          }
        : null,
      returns: wantInspection
        ? {
            standardRequested: wantReturns ? stdRequestedCount : 0,
            standardIn: wantReturns ? stdInCount : 0,
            refurbRequested: refRequestedCount,
            refurbIn: refInCount,
          }
        : null,
      friends: wantAccess
        ? {
            active: activeMembers,
            endingSoon: membersEndingSoon,
            ended: membersEnded,
            endingNext30: membersEndingByDay,
          }
        : null,
      content:
        wantBlog || wantCarousel || wantReviews
          ? {
              blogScheduled: wantBlog ? blogScheduled : null,
              blogPublished: wantBlog ? blogPublished : null,
              slidesActive: wantCarousel ? slidesActive : null,
              slidesTotal: wantCarousel ? slidesTotal : null,
              reviewsLast7Days: wantReviews ? reviewsWeek : null,
              reviewsLowStars: wantReviews ? reviewsLowStars : null,
            }
          : null,
      recentChanges: wantActivity
        ? (recentLogs?.logs || []).map((l) => {
            const byName = [l.actorFirstName, l.actorLastName].filter(Boolean).join(' ');
            return {
              id: l.id || l.publicId || String(l.createdAt),
              text: String(l.action || 'Change').replace(/_/g, ' '),
              at: l.createdAt,
              by: byName || l.actorEmail || 'System',
            };
          })
        : null,
      isAdmin,
      legacyPendingOrders,
    },
  };
}

function orderDateSqlParts(createdAt) {
  const gtePart = createdAt?.gte ? Prisma.sql`AND o."createdAt" >= ${createdAt.gte}` : Prisma.empty;
  const ltePart = createdAt?.lte ? Prisma.sql`AND o."createdAt" <= ${createdAt.lte}` : Prisma.empty;
  return { gtePart, ltePart };
}

async function refurbishedSalesRaw(createdAt) {
  const { gtePart, ltePart } = orderDateSqlParts(createdAt);
  const rows = await prisma.$queryRaw`
    SELECT COALESCE(SUM(oi."price" * oi."quantity"), 0)::float AS "sum"
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON oi."orderId" = o."id"
    INNER JOIN "Product" p ON oi."productId" = p."id"
    WHERE o."paymentStatus" = 'PAID'
      AND o."status" <> 'CANCELLED'
      AND p."productType" = 'REFURBISHED'
      ${gtePart}
      ${ltePart}
  `;
  return rows[0]?.sum ?? 0;
}

async function newProductSalesRaw(createdAt) {
  const { gtePart, ltePart } = orderDateSqlParts(createdAt);
  const rows = await prisma.$queryRaw`
    SELECT COALESCE(SUM(oi."price" * oi."quantity"), 0)::float AS "sum"
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON oi."orderId" = o."id"
    INNER JOIN "Product" p ON oi."productId" = p."id"
    WHERE o."paymentStatus" = 'PAID'
      AND o."status" <> 'CANCELLED'
      AND p."productType" <> 'REFURBISHED'
      ${gtePart}
      ${ltePart}
  `;
  return rows[0]?.sum ?? 0;
}

async function distinctOrderCountByProductType(createdAt, productType) {
  const { gtePart, ltePart } = orderDateSqlParts(createdAt);
  const typeFilter =
    productType === 'REFURBISHED'
      ? Prisma.sql`AND p."productType" = 'REFURBISHED'`
      : Prisma.sql`AND p."productType" <> 'REFURBISHED'`;
  const rows = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT o."id")::int AS "count"
    FROM "OrderItem" oi
    INNER JOIN "Order" o ON oi."orderId" = o."id"
    INNER JOIN "Product" p ON oi."productId" = p."id"
    WHERE o."paymentStatus" = 'PAID'
      AND o."status" <> 'CANCELLED'
      ${typeFilter}
      ${gtePart}
      ${ltePart}
  `;
  return rows[0]?.count ?? 0;
}

export async function listFinanceTransactions(
  page = 1,
  limit = 20,
  { dateFrom, dateTo, orderId, membershipRef, transactionType } = {}
) {
  const skip = (page - 1) * limit;
  const range = dateRangeWhere(dateFrom, dateTo);
  const gteOrder = range?.gte ? Prisma.sql`AND o."createdAt" >= ${range.gte}` : Prisma.empty;
  const lteOrder = range?.lte ? Prisma.sql`AND o."createdAt" <= ${range.lte}` : Prisma.empty;
  const gteMembership = range?.gte ? Prisma.sql`AND mp."paidAt" >= ${range.gte}` : Prisma.empty;
  const lteMembership = range?.lte ? Prisma.sql`AND mp."paidAt" <= ${range.lte}` : Prisma.empty;
  const gteRefund = range?.gte ? Prisma.sql`AND rr."refundedAt" >= ${range.gte}` : Prisma.empty;
  const lteRefund = range?.lte ? Prisma.sql`AND rr."refundedAt" <= ${range.lte}` : Prisma.empty;

  const orderFilter = orderId
    ? Prisma.sql`AND (o."orderNumber" ILIKE ${`%${orderId}%`} OR o."publicId" ILIKE ${`%${orderId}%`})`
    : Prisma.empty;
  const membershipFilter = membershipRef
    ? Prisma.sql`AND (mp."publicId" ILIKE ${`%${membershipRef}%`} OR mp."stripeSessionId" ILIKE ${`%${membershipRef}%`} OR u."accessNumber" ILIKE ${`%${membershipRef}%`})`
    : Prisma.empty;
  const refundOrderFilter = orderId
    ? Prisma.sql`AND (o."orderNumber" ILIKE ${`%${orderId}%`} OR o."publicId" ILIKE ${`%${orderId}%`} OR COALESCE(rr."returnNumber", '') ILIKE ${`%${orderId}%`})`
    : Prisma.empty;

  const type = String(transactionType || 'all').toLowerCase();
  const includeOrder = type === 'all' || type === 'payment' || type === 'order';
  const includeMembership = type === 'all' || type === 'access' || type === 'membership';
  const includeRefund = type === 'all' || type === 'refund';

  const parts = [];
  if (includeOrder) {
    parts.push(Prisma.sql`
      SELECT
        'order'::text AS "kind",
        'payment'::text AS "direction",
        o."publicId" AS "publicId",
        o."orderNumber" AS "reference",
        o."totalAmount"::float AS "amount",
        o."paymentStatus"::text AS "status",
        o."createdAt" AS "occurredAt",
        u."email" AS "customerEmail",
        u."firstName" AS "customerFirstName",
        u."lastName" AS "customerLastName",
        u."publicId" AS "userPublicId",
        NULL::text AS "stripeSessionId",
        NULL::text AS "returnPublicId"
      FROM "Order" o
      INNER JOIN "User" u ON o."userId" = u."id"
      WHERE o."paymentStatus" IN ('PAID', 'REFUNDED')
        AND o."status" <> 'CANCELLED'
        ${gteOrder}
        ${lteOrder}
        ${orderFilter}
    `);
  }
  if (includeMembership && !orderId) {
    parts.push(Prisma.sql`
      SELECT
        'membership'::text AS "kind",
        'payment'::text AS "direction",
        mp."publicId" AS "publicId",
        mp."type"::text AS "reference",
        mp."amount"::float AS "amount",
        'PAID'::text AS "status",
        mp."paidAt" AS "occurredAt",
        u."email" AS "customerEmail",
        u."firstName" AS "customerFirstName",
        u."lastName" AS "customerLastName",
        u."publicId" AS "userPublicId",
        mp."stripeSessionId" AS "stripeSessionId",
        NULL::text AS "returnPublicId"
      FROM "MembershipPayment" mp
      INNER JOIN "User" u ON mp."userId" = u."id"
      WHERE 1 = 1
        ${gteMembership}
        ${lteMembership}
        ${membershipFilter}
    `);
  }
  if (includeRefund) {
    parts.push(Prisma.sql`
      SELECT
        'refund'::text AS "kind",
        'refund'::text AS "direction",
        rr."publicId" AS "publicId",
        COALESCE(rr."returnNumber", o."orderNumber", rr."publicId") AS "reference",
        COALESCE(rr."refundAmount", 0)::float AS "amount",
        'REFUNDED'::text AS "status",
        rr."refundedAt" AS "occurredAt",
        u."email" AS "customerEmail",
        u."firstName" AS "customerFirstName",
        u."lastName" AS "customerLastName",
        u."publicId" AS "userPublicId",
        rr."stripeRefundId" AS "stripeSessionId",
        rr."publicId" AS "returnPublicId"
      FROM "ReturnRequest" rr
      INNER JOIN "Order" o ON rr."orderId" = o."id"
      INNER JOIN "User" u ON rr."userId" = u."id"
      WHERE rr."refundedAt" IS NOT NULL
        AND rr."refundAmount" IS NOT NULL
        AND rr."type" = 'STANDARD'
        ${gteRefund}
        ${lteRefund}
        ${refundOrderFilter}
    `);
    parts.push(Prisma.sql`
      SELECT
        'cancellation'::text AS "kind",
        'refund'::text AS "direction",
        o."publicId" AS "publicId",
        COALESCE(o."orderNumber", o."publicId") AS "reference",
        o."totalAmount"::float AS "amount",
        'CANCELLED'::text AS "status",
        o."updatedAt" AS "occurredAt",
        u."email" AS "customerEmail",
        u."firstName" AS "customerFirstName",
        u."lastName" AS "customerLastName",
        u."publicId" AS "userPublicId",
        o."stripePaymentIntentId" AS "stripeSessionId",
        NULL::text AS "returnPublicId"
      FROM "Order" o
      INNER JOIN "User" u ON o."userId" = u."id"
      WHERE o."status" = 'CANCELLED'
        AND o."paymentStatus" IN ('REFUNDED', 'PARTIALLY_REFUNDED')
        ${gteOrder}
        ${lteOrder}
        ${orderFilter}
    `);
  }

  if (!parts.length) {
    return {
      transactions: [],
      pagination: { total: 0, page, limit, pages: 1 },
    };
  }

  const unionSql = parts.reduce((acc, part, idx) => (idx === 0 ? part : Prisma.sql`${acc} UNION ALL ${part}`));

  const [countRows, rows] = await Promise.all([
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS "count"
      FROM (
        ${unionSql}
      ) combined
    `,
    prisma.$queryRaw`
      SELECT *
      FROM (
        ${unionSql}
      ) combined
      ORDER BY "occurredAt" DESC
      LIMIT ${limit} OFFSET ${skip}
    `,
  ]);

  const total = countRows[0]?.count ?? 0;

  return {
    transactions: rows.map((row) => ({
      kind: row.kind,
      direction: row.direction || (row.kind === 'refund' ? 'refund' : 'payment'),
      publicId: row.publicId,
      reference: row.reference,
      amount: row.amount,
      status: row.status,
      occurredAt: row.occurredAt,
      customerEmail: row.customerEmail,
      customerName: [row.customerFirstName, row.customerLastName].filter(Boolean).join(' ') || null,
      userPublicId: row.userPublicId ?? null,
      stripeSessionId: row.stripeSessionId ?? null,
      returnPublicId: row.returnPublicId ?? null,
    })),
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    },
  };
}

const CUSTOMER_LIST_ROLES = ['CUSTOMER', 'USER'];
const MEMBERSHIP_EXPIRING_DAYS = 30;
const GUEST_LOOKUP_DAYS = 45;

function membershipStatusFromUntil(accessMemberUntil) {
  if (!accessMemberUntil) return null;
  const until = new Date(accessMemberUntil).getTime();
  if (Number.isNaN(until)) return null;
  const daysLeft = (until - Date.now()) / (24 * 60 * 60 * 1000);
  if (daysLeft < 0) return 'Expired';
  if (daysLeft <= MEMBERSHIP_EXPIRING_DAYS) return 'Expiring soon';
  return 'Active';
}

function customerTabClause(tab) {
  const now = new Date();
  switch (tab) {
    case 'friends':
      return { isGuest: false, accessMemberUntil: { gt: now } };
    case 'customer':
      return {
        isGuest: false,
        OR: [{ accessMemberUntil: null }, { accessMemberUntil: { lte: now } }],
      };
    case 'guest':
      return { isGuest: true };
    case 'inactive':
      return { isActive: false };
    case 'all':
    default:
      // Prototype "All" = registered accounts (guests live on their own tab).
      return { isGuest: false };
  }
}

function membershipFilterClause(mem) {
  const now = new Date();
  const soon = new Date(now.getTime() + MEMBERSHIP_EXPIRING_DAYS * 24 * 60 * 60 * 1000);
  switch (mem) {
    case 'Active':
      return { isGuest: false, accessMemberUntil: { gt: soon } };
    case 'Expiring soon':
      return { isGuest: false, accessMemberUntil: { gt: now, lte: soon } };
    case 'Expired':
      return { isGuest: false, accessMemberUntil: { lte: now } };
    case 'Cancelled':
      // No dedicated cancel flag yet — treat as expired / ended membership.
      return { isGuest: false, accessMemberUntil: { lte: now } };
    default:
      return null;
  }
}

export async function listCustomers(
  page = 1,
  limit = 20,
  { search, role, tab = 'all', membership, has, sort = 'new' } = {}
) {
  const skip = (page - 1) * limit;
  const and = [];

  if (role && String(role).trim()) {
    and.push({ role: { name: String(role).trim() } });
  } else {
    and.push({ role: { name: { in: CUSTOMER_LIST_ROLES } } });
  }

  const tabClause = customerTabClause(String(tab || 'all'));
  if (tabClause) and.push(tabClause);

  const memClause = membershipFilterClause(membership);
  if (memClause) and.push(memClause);

  if (has === 'orders') and.push({ orders: { some: {} } });
  else if (has === 'none') and.push({ orders: { none: {} } });
  else if (has === 'credit') and.push({ storeCreditWallet: { balance: { gt: 0 } } });

  if (search && String(search).trim()) {
    const q = String(search).trim();
    and.push({
      OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { accessNumber: { contains: q, mode: 'insensitive' } },
        { publicId: { contains: q, mode: 'insensitive' } },
      ],
    });
  }

  const where = { AND: and };
  const baseRoleWhere = {
    role: { name: { in: CUSTOMER_LIST_ROLES } },
  };

  let orderBy = { createdAt: 'desc' };
  if (sort === 'oldest') orderBy = { createdAt: 'asc' };
  else if (sort === 'name') orderBy = [{ firstName: 'asc' }, { lastName: 'asc' }];
  else if (sort === 'orders') orderBy = { orders: { _count: 'desc' } };

  const needsSpendSort = sort === 'spent';

  const select = {
    id: true,
    publicId: true,
    email: true,
    firstName: true,
    lastName: true,
    phone: true,
    isActive: true,
    isGuest: true,
    accessNumber: true,
    accessMemberUntil: true,
    createdAt: true,
    guestCreatedAt: true,
    role: { select: { name: true } },
    storeCreditWallet: { select: { balance: true } },
    _count: { select: { orders: true } },
    orders: {
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { createdAt: true, totalAmount: true },
    },
  };

  let users;
  let total;

  if (needsSpendSort) {
    const matching = await prisma.user.findMany({
      where,
      select: { id: true },
    });
    total = matching.length;
    const ids = matching.map((u) => u.id);
    const spendRows =
      ids.length === 0
        ? []
        : await prisma.order.groupBy({
            by: ['userId'],
            where: {
              userId: { in: ids },
              status: { not: 'CANCELLED' },
              paymentStatus: 'PAID',
            },
            _sum: { totalAmount: true },
          });
    const spendMap = Object.fromEntries(
      spendRows.map((r) => [r.userId, Number(r._sum.totalAmount || 0)])
    );
    ids.sort((a, b) => (spendMap[b] || 0) - (spendMap[a] || 0));
    const pageIds = ids.slice(skip, skip + limit);
    users =
      pageIds.length === 0
        ? []
        : await prisma.user.findMany({
            where: { id: { in: pageIds } },
            select,
          });
    const orderIndex = Object.fromEntries(pageIds.map((id, i) => [id, i]));
    users.sort((a, b) => (orderIndex[a.id] ?? 0) - (orderIndex[b.id] ?? 0));
  } else {
    [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        select,
      }),
      prisma.user.count({ where }),
    ]);
  }

  const userIds = users.map((u) => u.id);
  const spendRows =
    userIds.length === 0
      ? []
      : await prisma.order.groupBy({
          by: ['userId'],
          where: {
            userId: { in: userIds },
            status: { not: 'CANCELLED' },
            paymentStatus: 'PAID',
          },
          _sum: { totalAmount: true },
        });
  const spendByUser = Object.fromEntries(
    spendRows.map((r) => [r.userId, Number(r._sum.totalAmount || 0)])
  );

  const [all, friends, customer, guest, inactive] = await Promise.all([
    prisma.user.count({ where: { AND: [baseRoleWhere, customerTabClause('all')] } }),
    prisma.user.count({ where: { AND: [baseRoleWhere, customerTabClause('friends')] } }),
    prisma.user.count({ where: { AND: [baseRoleWhere, customerTabClause('customer')] } }),
    prisma.user.count({ where: { AND: [baseRoleWhere, customerTabClause('guest')] } }),
    prisma.user.count({ where: { AND: [baseRoleWhere, customerTabClause('inactive')] } }),
  ]);

  const customers = users.map((u) => {
    const { _count, orders, storeCreditWallet, ...rest } = u;
    const lastOrderAt = orders[0]?.createdAt ?? null;
    const membershipStatus = membershipStatusFromUntil(u.accessMemberUntil);
    let guestLookupDaysLeft = null;
    if (u.isGuest) {
      const anchor = lastOrderAt || u.guestCreatedAt || u.createdAt;
      const ageDays = (Date.now() - new Date(anchor).getTime()) / (24 * 60 * 60 * 1000);
      guestLookupDaysLeft = Math.max(0, Math.ceil(GUEST_LOOKUP_DAYS - ageDays));
    }
    return {
      ...rest,
      orderCount: _count.orders,
      totalSpend: spendByUser[u.id] ?? 0,
      lastOrderAt,
      storeCreditBalance: Number(storeCreditWallet?.balance || 0),
      membershipStatus,
      accessMemberActive: membershipStatus === 'Active' || membershipStatus === 'Expiring soon',
      guestLookupDaysLeft,
    };
  });

  return {
    customers,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
    tabCounts: { all, friends, customer, guest, inactive },
  };
}

export async function getCustomerDetail(userPublicId) {
  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: {
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      isActive: true,
      isGuest: true,
      accessMemberUntil: true,
      accessNumber: true,
      babyName: true,
      createdAt: true,
      role: { select: { name: true } },
      storeCreditWallet: {
        select: {
          balance: true,
          publicId: true,
          transactions: {
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
              publicId: true,
              type: true,
              amount: true,
              note: true,
              orderPublicId: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });
  if (!user || !isStorefrontCustomerRole(user.role?.name)) {
    throw new AppError(404, 'Customer not found');
  }

  const uid = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: { id: true },
  });

  const [orderAgg, orders, returns, returnsCount, cancellations, addresses, membershipPayments] =
    await Promise.all([
      prisma.order.aggregate({
        where: { userId: uid.id, paymentStatus: 'PAID', status: { not: 'CANCELLED' } },
        _sum: { totalAmount: true },
        _count: true,
      }),
      prisma.order.findMany({
        where: { userId: uid.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          publicId: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          totalAmount: true,
          createdAt: true,
        },
      }),
      prisma.returnRequest.findMany({
        where: { userId: uid.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          publicId: true,
          returnNumber: true,
          submissionPublicId: true,
          status: true,
          type: true,
          createdAt: true,
          manualTrackingNumber: true,
          customerShippingSubmittedAt: true,
          shipByDeadline: true,
          keepWaitingUntil: true,
          creditAwarded: true,
          order: { select: { publicId: true, orderNumber: true } },
          packageRequests: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              status: true,
              uspsTrackingNumber: true,
              expectedDeliveryDate: true,
            },
          },
        },
      }),
      prisma.returnRequest.count({ where: { userId: uid.id } }),
      prisma.order.count({
        where: { userId: uid.id, status: 'CANCELLED' },
      }),
      prisma.address.findMany({
        where: { userId: uid.id },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        take: 5,
        select: {
          publicId: true,
          fullName: true,
          addressLine1: true,
          addressLine2: true,
          street: true,
          city: true,
          state: true,
          zipCode: true,
          country: true,
          phoneNumber: true,
          isDefault: true,
        },
      }),
      prisma.membershipPayment.findMany({
        where: { userId: uid.id },
        orderBy: { paidAt: 'desc' },
        take: 10,
        select: {
          publicId: true,
          type: true,
          amount: true,
          currency: true,
          paidAt: true,
          accessValidUntil: true,
        },
      }),
    ]);

  const { storeCreditWallet, ...userRest } = user;

  return {
    user: userRest,
    walletBalance: storeCreditWallet?.balance ?? 0,
    walletPublicId: storeCreditWallet?.publicId ?? null,
    storeCreditTransactions: storeCreditWallet?.transactions ?? [],
    totalSpend: orderAgg._sum.totalAmount ?? 0,
    orderCount: orderAgg._count,
    orders,
    returns: returns.map((row) => ({
      ...row,
      packageRequest: row.packageRequests?.[0] ?? null,
      packageRequests: undefined,
    })),
    returnsCount,
    addresses,
    membershipPayments,
    cancellationsCount: cancellations,
  };
}

export async function setUserActive(userPublicId, isActive) {
  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: { id: true, role: { select: { name: true } } },
  });
  if (!user) throw new AppError(404, 'User not found');
  if (!isStorefrontCustomerRole(user.role?.name)) {
    throw new AppError(400, 'Only customer accounts can be activated/deactivated here');
  }
  return prisma.user.update({
    where: { id: user.id },
    data: { isActive: Boolean(isActive) },
    select: {
      publicId: true,
      email: true,
      isActive: true,
    },
  });
}

export async function listAccessMembers({ filter = 'all' } = {}) {
  const now = new Date();
  const soon = new Date(now.getTime() + MEMBERSHIP_EXPIRING_DAYS * 24 * 60 * 60 * 1000);
  let where = { accessMemberUntil: { not: null } };
  if (filter === 'active') {
    where = { accessMemberUntil: { gt: soon } };
  } else if (filter === 'expiring') {
    where = { accessMemberUntil: { gt: now, lte: soon } };
  } else if (filter === 'expired') {
    where = { accessMemberUntil: { not: null, lte: now } };
  }

  const users = await prisma.user.findMany({
    where,
    orderBy: { accessMemberUntil: 'asc' },
    select: {
      id: true,
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      accessNumber: true,
      accessMemberUntil: true,
      accessRenewalReminderSentAt: true,
      createdAt: true,
      membershipPayments: {
        orderBy: { paidAt: 'asc' },
        take: 1,
        select: { paidAt: true, amount: true },
      },
    },
  });

  const members = users.map((u) => {
    const membershipStatus = membershipStatusFromUntil(u.accessMemberUntil);
    const startedAt =
      u.membershipPayments[0]?.paidAt ||
      (u.accessMemberUntil
        ? new Date(
            new Date(u.accessMemberUntil).getTime() - 365 * 24 * 60 * 60 * 1000
          )
        : null);
    const { membershipPayments, ...rest } = u;
    return {
      ...rest,
      startedAt,
      membershipStatus,
      accessMemberActive: membershipStatus === 'Active' || membershipStatus === 'Expiring soon',
      reminderSentAt: u.accessRenewalReminderSentAt,
      feePaid: membershipPayments[0]?.amount ?? null,
    };
  });

  const allWithMembership = await prisma.user.findMany({
    where: { accessMemberUntil: { not: null } },
    select: { accessMemberUntil: true },
  });
  const statusCounts = { active: 0, expiring: 0, expired: 0, cancelled: 0 };
  for (const u of allWithMembership) {
    const s = membershipStatusFromUntil(u.accessMemberUntil);
    if (s === 'Active') statusCounts.active += 1;
    else if (s === 'Expiring soon') statusCounts.expiring += 1;
    else if (s === 'Expired') statusCounts.expired += 1;
  }

  return {
    members,
    statusCounts,
    total: allWithMembership.length,
  };
}

export async function getBusinessSettings() {
  const row =
    (await prisma.businessSettings.findUnique({ where: { id: 1 } })) ||
    (await prisma.businessSettings.create({
      data: { id: 1, accessMembershipPriceUsd: 50 },
    }));
  return {
    accessMembershipPriceUsd: row.accessMembershipPriceUsd,
    accessUsedReturnWindowDays: row.accessUsedReturnWindowDays ?? 365,
    membershipSharingEnabled: row.membershipSharingEnabled !== false,
    membershipShareMaxUsers: row.membershipShareMaxUsers ?? 0,
    membershipShareMaxPerDay: row.membershipShareMaxPerDay ?? 0,
    membershipShareMaxPerMonth: row.membershipShareMaxPerMonth ?? 0,
    membershipShareMaxPerYear: row.membershipShareMaxPerYear ?? 0,
    updatedAt: row.updatedAt,
  };
}

function nonNegativeInt(value, label) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 100000) {
    throw new AppError(400, `Invalid ${label}`);
  }
  return n;
}

export async function updateBusinessSettings({
  accessMembershipPriceUsd,
  accessUsedReturnWindowDays,
  membershipSharingEnabled,
  membershipShareMaxUsers,
  membershipShareMaxPerDay,
  membershipShareMaxPerMonth,
  membershipShareMaxPerYear,
}) {
  if (accessMembershipPriceUsd != null) {
    const n = Number(accessMembershipPriceUsd);
    if (Number.isNaN(n) || n < 0 || n > 99999) {
      throw new AppError(400, 'Invalid membership price');
    }
    await prisma.businessSettings.upsert({
      where: { id: 1 },
      create: { id: 1, accessMembershipPriceUsd: n },
      update: { accessMembershipPriceUsd: n },
    });
  }
  if (accessUsedReturnWindowDays != null) {
    const days = Math.floor(Number(accessUsedReturnWindowDays));
    if (!Number.isFinite(days) || days < 30 || days > 730) {
      throw new AppError(400, 'Used return window must be between 30 and 730 days');
    }
    await prisma.businessSettings.upsert({
      where: { id: 1 },
      create: { id: 1, accessUsedReturnWindowDays: days },
      update: { accessUsedReturnWindowDays: days },
    });
  }
  const sharingPatch = {};
  if (membershipSharingEnabled != null) sharingPatch.membershipSharingEnabled = Boolean(membershipSharingEnabled);
  if (membershipShareMaxUsers != null) sharingPatch.membershipShareMaxUsers = nonNegativeInt(membershipShareMaxUsers, 'user limit');
  if (membershipShareMaxPerDay != null) sharingPatch.membershipShareMaxPerDay = nonNegativeInt(membershipShareMaxPerDay, 'daily limit');
  if (membershipShareMaxPerMonth != null) sharingPatch.membershipShareMaxPerMonth = nonNegativeInt(membershipShareMaxPerMonth, 'monthly limit');
  if (membershipShareMaxPerYear != null) sharingPatch.membershipShareMaxPerYear = nonNegativeInt(membershipShareMaxPerYear, 'yearly limit');
  if (Object.keys(sharingPatch).length) {
    await prisma.businessSettings.upsert({
      where: { id: 1 },
      create: { id: 1, ...sharingPatch },
      update: sharingPatch,
    });
  }
  return getBusinessSettings();
}

async function assertActorIsAdmin(actorPublicId) {
  const actor = await prisma.user.findUnique({
    where: { publicId: actorPublicId },
    select: { role: { select: { name: true } } },
  });
  if (!actor || actor.role?.name !== 'ADMIN') {
    throw new AppError(403, 'Only super admins can manage team modules');
  }
}

function normalizeAdminModuleOptions(raw) {
  const orders =
    raw && typeof raw === 'object' && (raw.orders === 'assigned' || raw.orders === 'all')
      ? raw.orders
      : 'all';
  return { orders };
}

function deriveTeamStatus(user) {
  if (!user.isActive) return 'inactive';
  if (user.role?.name === 'ADMIN_TEAM' && user.mustChangePassword === true) return 'invited';
  return 'active';
}

function mapTeamMemberRow(user) {
  const access = serializeAdminAccess(user.adminModules);
  const isDefault = user.role?.name === 'ADMIN';
  const invitePending = user.role?.name === 'ADMIN_TEAM' && user.mustChangePassword === true;
  const roleTitle = isDefault
    ? 'Default admin'
    : user.roleTitle || null;
  return {
    publicId: user.publicId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone || null,
    roleTitle,
    adminModules: access,
    adminModuleOptions: normalizeAdminModuleOptions(user.adminModuleOptions),
    adminNotificationAccess: Boolean(user.adminNotificationAccess),
    isActive: user.isActive,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    isDefault,
    invitePending,
    status: deriveTeamStatus(user),
    moduleCount: Object.keys(access || {}).filter((k) => (access[k] || []).length > 0).length,
  };
}

const TEAM_MEMBER_SELECT = {
  publicId: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  roleTitle: true,
  adminModules: true,
  adminModuleOptions: true,
  adminNotificationAccess: true,
  isActive: true,
  mustChangePassword: true,
  createdAt: true,
  lastLoginAt: true,
  role: { select: { name: true } },
};

export async function listAdminTeamMembers(actorPublicId) {
  void actorPublicId;
  const roles = await prisma.role.findMany({
    where: { name: { in: ['ADMIN', 'ADMIN_TEAM'] } },
    select: { id: true, name: true },
  });
  if (!roles.length) return { members: [], supportEmail: config.brand?.supportEmail || null };
  const users = await prisma.user.findMany({
    where: { roleId: { in: roles.map((role) => role.id) } },
    orderBy: [{ role: { name: 'asc' } }, { email: 'asc' }],
    select: TEAM_MEMBER_SELECT,
  });
  return {
    supportEmail: config.brand?.supportEmail || null,
    members: users.map(mapTeamMemberRow),
  };
}

export async function getAdminTeamMember(actorPublicId, targetPublicId) {
  void actorPublicId;
  const user = await prisma.user.findUnique({
    where: { publicId: targetPublicId },
    select: {
      ...TEAM_MEMBER_SELECT,
      addresses: {
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        take: 1,
        select: {
          publicId: true,
          fullName: true,
          addressLine1: true,
          addressLine2: true,
          street: true,
          city: true,
          state: true,
          zipCode: true,
          country: true,
          phoneNumber: true,
        },
      },
    },
  });
  if (!user || (user.role?.name !== 'ADMIN' && user.role?.name !== 'ADMIN_TEAM')) {
    throw new AppError(404, 'Team member not found');
  }
  const address = user.addresses?.[0] || null;
  return {
    ...mapTeamMemberRow(user),
    address: address
      ? {
          publicId: address.publicId,
          line1: address.addressLine1 || address.street || '',
          line2: address.addressLine2 || '',
          city: address.city || '',
          state: address.state || '',
          zip: address.zipCode || '',
          country: address.country || 'US',
          phoneNumber: address.phoneNumber || null,
        }
      : null,
  };
}

async function issueTeamSetPasswordEmail(user, roleTitle) {
  const setPasswordToken = crypto.randomBytes(32).toString('hex');
  await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
  await prisma.passwordResetToken.create({
    data: {
      token: hashAuthToken(setPasswordToken),
      userId: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const setPasswordUrl = `${config.frontend.adminUrl}/reset-password?token=${setPasswordToken}`;
  await emailService.sendTemplate({
    to: user.email,
    template: 'team-invite',
    context: {
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      email: user.email,
      roleTitle: roleTitle || 'Team Member',
      actionUrl: setPasswordUrl,
      loginUrl: setPasswordUrl,
      supportEmail: config.brand?.supportEmail || null,
    },
  });
}

export async function createAdminTeamMember(actorPublicId, payload) {
  await assertActorIsAdmin(actorPublicId);
  const teamRole = await prisma.role.findUnique({ where: { name: 'ADMIN_TEAM' } });
  if (!teamRole) throw new AppError(500, 'ADMIN_TEAM role missing');

  const email = String(payload.email || '').trim().toLowerCase();
  const firstName = payload.firstName ? String(payload.firstName).trim() : null;
  const lastName = payload.lastName ? String(payload.lastName).trim() : null;
  const roleTitle = payload.roleTitle ? String(payload.roleTitle).trim() : null;
  const modules = payload.modules;
  const adminNotificationAccess = Boolean(payload.adminNotificationAccess);

  // Free CUSTOMER slot if a legacy staff-role user was mis-scoped there.
  await rehomeMisScopedStaffToStaffPortal(prisma, email);

  const existing = await findUserByEmailAndPortal(prisma, email, PORTAL_SCOPE.STAFF);
  if (existing) {
    throw new AppError(
      400,
      'This email is already a team member. Open Admin → Team to edit their access.',
      'EMAIL_TAKEN_STAFF',
      { existingTeamMemberId: existing.publicId }
    );
  }

  const accessMap =
    normalizeTeamAccessPayload(payload.access ?? modules) ||
    normalizeTeamAccessPayload(normalizeTeamPermissionModules(modules));
  if (!accessMap || Object.keys(accessMap).length === 0) {
    throw new AppError(400, 'At least one module permission is required');
  }

  const inviteMethod = payload.inviteMethod === 'invite' ? 'invite' : 'temp';
  const phone = payload.phone != null ? String(payload.phone).trim() || null : null;
  const moduleOptions = normalizeAdminModuleOptions(payload.adminModuleOptions);
  const emailCreds = payload.emailCreds !== false;

  let oneTimePassword = null;
  let hashed;
  if (inviteMethod === 'temp') {
    oneTimePassword = generateTeamOneTimePassword();
    hashed = await bcrypt.hash(oneTimePassword, 10);
  } else {
    hashed = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  }

  let created;
  try {
    created = await prisma.user.create({
      data: {
        email,
        password: hashed,
        firstName,
        lastName,
        phone,
        roleTitle,
        roleId: teamRole.id,
        portalScope: PORTAL_SCOPE.STAFF,
        adminModules: accessMap,
        adminModuleOptions: moduleOptions,
        adminNotificationAccess,
        emailVerifiedAt: new Date(),
        isActive: true,
        mustChangePassword: true,
      },
      select: TEAM_MEMBER_SELECT,
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      throw new AppError(
        400,
        'This email is already a team member. Open Admin → Team to edit their access.',
        'EMAIL_TAKEN_STAFF'
      );
    }
    throw err;
  }
  await writeAdminAudit({
    actorId: actorPublicId,
    action: 'TEAM_MEMBER_CREATED',
    entityType: 'User',
    entityId: created.publicId,
    meta: {
      modules: Object.keys(accessMap),
      access: accessMap,
      roleTitle,
      adminNotificationAccess,
      inviteMethod,
      adminModuleOptions: moduleOptions,
    },
  });
  const createdRow = await prisma.user.findUnique({
    where: { publicId: created.publicId },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  try {
    if (createdRow && (inviteMethod === 'invite' || emailCreds)) {
      await issueTeamSetPasswordEmail(createdRow, roleTitle);
    }
  } catch (error) {
    await writeAdminAudit({
      actorId: actorPublicId,
      action: 'TEAM_INVITE_EMAIL_FAILED',
      entityType: 'User',
      entityId: created.publicId,
      meta: { error: String(error?.message || error) },
    });
  }
  return {
    ...mapTeamMemberRow(created),
    inviteMethod,
    ...(oneTimePassword ? { oneTimePassword } : {}),
  };
}

function generateTeamOneTimePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*';
  const all = upper + lower + digits + symbols;
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  for (let i = chars.length; i < 14; i += 1) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export async function setTeamMemberModules(actorPublicId, targetPublicId, modules) {
  await assertActorIsAdmin(actorPublicId);
  const teamRole = await prisma.role.findUnique({ where: { name: 'ADMIN_TEAM' } });
  if (!teamRole) throw new AppError(500, 'ADMIN_TEAM role missing');

  const accessMap =
    normalizeTeamAccessPayload(modules) ||
    normalizeTeamAccessPayload(normalizeTeamPermissionModules(modules));
  if (!accessMap || Object.keys(accessMap).length === 0) {
    throw new AppError(400, 'At least one module permission is required');
  }
  const normalized = Object.keys(accessMap);

  const target = await prisma.user.findUnique({
    where: { publicId: targetPublicId },
    select: { id: true, roleId: true },
  });
  if (!target || target.roleId !== teamRole.id) {
    throw new AppError(404, 'Team member not found');
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { adminModules: accessMap },
    select: TEAM_MEMBER_SELECT,
  });
  await writeAdminAudit({
    actorId: actorPublicId,
    action: 'TEAM_MODULES_UPDATED',
    entityType: 'User',
    entityId: updated.publicId,
    meta: { modules: normalized, access: accessMap },
  });
  return mapTeamMemberRow(updated);
}

export async function updateTeamMember(actorPublicId, targetPublicId, payload) {
  await assertActorIsAdmin(actorPublicId);
  const teamRole = await prisma.role.findUnique({ where: { name: 'ADMIN_TEAM' } });
  if (!teamRole) throw new AppError(500, 'ADMIN_TEAM role missing');
  const target = await prisma.user.findUnique({
    where: { publicId: targetPublicId },
    select: { id: true, roleId: true, publicId: true },
  });
  if (!target || target.roleId !== teamRole.id) throw new AppError(404, 'Team member not found');

  const data = {};
  if (payload.firstName !== undefined) {
    data.firstName = payload.firstName ? String(payload.firstName).trim() : null;
  }
  if (payload.lastName !== undefined) {
    data.lastName = payload.lastName ? String(payload.lastName).trim() : null;
  }
  if (payload.roleTitle !== undefined) {
    data.roleTitle = payload.roleTitle ? String(payload.roleTitle).trim() : null;
  }
  if (payload.phone !== undefined) {
    data.phone = payload.phone ? String(payload.phone).trim() : null;
  }
  if (payload.isActive !== undefined) data.isActive = Boolean(payload.isActive);
  if (payload.adminNotificationAccess !== undefined) {
    data.adminNotificationAccess = Boolean(payload.adminNotificationAccess);
  }
  if (payload.adminModuleOptions !== undefined) {
    data.adminModuleOptions = normalizeAdminModuleOptions(payload.adminModuleOptions);
  }
  if (payload.modules !== undefined || payload.access !== undefined) {
    const accessMap = normalizeTeamAccessPayload(payload.access ?? payload.modules);
    if (!accessMap || Object.keys(accessMap).length === 0) {
      throw new AppError(400, 'At least one module permission is required');
    }
    data.adminModules = accessMap;
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data,
    select: TEAM_MEMBER_SELECT,
  });

  if (payload.address && typeof payload.address === 'object') {
    await upsertTeamMemberAddress(target.id, payload.address);
  }

  await writeAdminAudit({
    actorId: actorPublicId,
    action: 'TEAM_MEMBER_UPDATED',
    entityType: 'User',
    entityId: updated.publicId,
    meta: {
      firstName: updated.firstName,
      lastName: updated.lastName,
      roleTitle: updated.roleTitle || null,
      phone: updated.phone || null,
      isActive: updated.isActive,
      modules: updated.adminModules,
      adminNotificationAccess: updated.adminNotificationAccess,
      adminModuleOptions: updated.adminModuleOptions,
    },
  });
  return getAdminTeamMember(actorPublicId, updated.publicId);
}

async function upsertTeamMemberAddress(userId, address) {
  const line1 = String(address.line1 || address.addressLine1 || address.street || '').trim();
  const line2 = String(address.line2 || address.addressLine2 || '').trim();
  const city = String(address.city || '').trim();
  const state = String(address.state || '').trim();
  const zip = String(address.zip || address.zipCode || '').trim();
  const country = String(address.country || 'US').trim() || 'US';
  const phoneNumber = address.phoneNumber != null ? String(address.phoneNumber).trim() || null : null;

  if (!line1 && !city && !state && !zip) {
    return;
  }
  if (!line1 || !city || !state || !zip) {
    throw new AppError(400, 'Address needs street, city, state and ZIP.');
  }

  const existing = await prisma.address.findFirst({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    select: { id: true },
  });
  const data = {
    street: line1,
    addressLine1: line1,
    addressLine2: line2 || null,
    city,
    state,
    zipCode: zip,
    country,
    phoneNumber,
    isDefault: true,
    addressType: 'BUSINESS',
  };
  if (existing) {
    await prisma.address.update({ where: { id: existing.id }, data });
  } else {
    await prisma.address.create({ data: { ...data, userId } });
  }
}

async function findManagedTeamUser(targetPublicId) {
  const target = await prisma.user.findUnique({
    where: { publicId: targetPublicId },
    select: {
      id: true,
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      roleTitle: true,
      isActive: true,
      mustChangePassword: true,
      role: { select: { name: true } },
    },
  });
  if (!target || (target.role?.name !== 'ADMIN' && target.role?.name !== 'ADMIN_TEAM')) {
    throw new AppError(404, 'Team member not found');
  }
  return target;
}

export async function resendTeamInvite(actorPublicId, targetPublicId) {
  await assertActorIsAdmin(actorPublicId);
  const target = await findManagedTeamUser(targetPublicId);
  if (target.role?.name === 'ADMIN') {
    throw new AppError(400, 'The default admin already has a password. Use forgot password on the sign-in page.');
  }
  await prisma.user.update({
    where: { id: target.id },
    data: { mustChangePassword: true },
  });
  await issueTeamSetPasswordEmail(target, target.roleTitle || target.phone);
  await writeAdminAudit({
    actorId: actorPublicId,
    action: 'TEAM_INVITE_RESENT',
    entityType: 'User',
    entityId: target.publicId,
    meta: { email: target.email },
  });
  return { publicId: target.publicId, email: target.email, invitePending: true };
}

export async function resetTeamMemberPassword(actorPublicId, targetPublicId) {
  await assertActorIsAdmin(actorPublicId);
  const target = await findManagedTeamUser(targetPublicId);
  if (target.role?.name === 'ADMIN') {
    throw new AppError(400, 'Reset the default admin password from the sign-in page.');
  }
  await prisma.user.update({
    where: { id: target.id },
    data: { mustChangePassword: true, tokenVersion: { increment: 1 } },
  });
  await issueTeamSetPasswordEmail(target, target.roleTitle || target.phone);
  await writeAdminAudit({
    actorId: actorPublicId,
    action: 'TEAM_PASSWORD_RESET',
    entityType: 'User',
    entityId: target.publicId,
    meta: { email: target.email },
  });
  return { publicId: target.publicId, email: target.email, invitePending: true };
}

export async function listTeamMemberActivity(actorPublicId, targetPublicId, { limit = 6 } = {}) {
  void actorPublicId;
  const target = await findManagedTeamUser(targetPublicId);
  const take = Math.min(Math.max(Number(limit) || 6, 1), 50);
  const rows = await prisma.adminAuditLog.findMany({
    where: { actorId: target.publicId },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      publicId: true,
      action: true,
      entityType: true,
      entityId: true,
      meta: true,
      createdAt: true,
    },
  });
  const signIns = await prisma.adminAuditLog.findMany({
    where: { actorId: target.publicId, action: 'STAFF_SIGN_IN' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      publicId: true,
      meta: true,
      createdAt: true,
    },
  });
  return {
    publicId: target.publicId,
    events: rows.map((row) => ({
      id: row.publicId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      meta: row.meta,
      createdAt: row.createdAt,
      ok: !String(row.action || '').includes('FAILED'),
    })),
    signIns: signIns.map((row) => ({
      id: row.publicId,
      createdAt: row.createdAt,
      userAgent: row.meta?.userAgent || null,
      ip: row.meta?.ip || null,
    })),
  };
}

export async function deleteTeamMember(actorPublicId, targetPublicId) {
  await assertActorIsAdmin(actorPublicId);
  const target = await findManagedTeamUser(targetPublicId);
  if (target.role?.name === 'ADMIN') {
    throw new AppError(400, 'The default admin account cannot be deleted.');
  }
  if (target.publicId === actorPublicId) {
    throw new AppError(400, 'You cannot delete the account you are signed in with.');
  }

  const [orders, returns, memberships, checkouts, adjustments, wallet] = await Promise.all([
    prisma.order.count({ where: { userId: target.id } }),
    prisma.returnRequest.count({ where: { userId: target.id } }),
    prisma.membershipPayment.count({ where: { userId: target.id } }),
    prisma.checkoutIntent.count({ where: { userId: target.id } }),
    prisma.inventoryAdjustment.count({ where: { userId: target.id } }),
    prisma.storeCreditWallet.count({ where: { userId: target.id } }),
  ]);
  const hasHistory = orders + returns + memberships + checkouts + adjustments + wallet > 0;
  if (hasHistory) {
    await prisma.user.update({
      where: { id: target.id },
      data: { isActive: false },
    });
    await writeAdminAudit({
      actorId: actorPublicId,
      action: 'TEAM_MEMBER_DISABLED',
      entityType: 'User',
      entityId: target.publicId,
      meta: { reason: 'history-exists' },
    });
    return {
      mode: 'disabled',
      publicId: target.publicId,
      message: 'This account has history, so it was disabled instead of deleted.',
    };
  }

  try {
    await prisma.user.delete({ where: { id: target.id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
      await prisma.user.update({
        where: { id: target.id },
        data: { isActive: false },
      });
      return {
        mode: 'disabled',
        publicId: target.publicId,
        message: 'This account has history, so it was disabled instead of deleted.',
      };
    }
    throw error;
  }
  await writeAdminAudit({
    actorId: actorPublicId,
    action: 'TEAM_MEMBER_DELETED',
    entityType: 'User',
    entityId: target.publicId,
    meta: { email: target.email },
  });
  return { mode: 'deleted', publicId: target.publicId, message: 'Team invite deleted.' };
}
