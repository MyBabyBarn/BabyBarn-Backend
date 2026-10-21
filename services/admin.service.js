import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AppError } from '../utils/error-handler.js';
import { normalizeTeamPermissionModules } from '../constants/admin-modules.js';
import { emailService } from './email.service.js';
import { writeAdminAudit } from './audit.service.js';
import { config } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { PORTAL_SCOPE, findUserByEmailAndPortal, rehomeMisScopedStaffToStaffPortal } from '../lib/portal-scope.js';
import { buildLegacyAdminPendingCountWhere } from '../lib/order-query-filters.js';

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

export async function getFinanceStats({ dateFrom, dateTo } = {}) {
  const createdAt = dateRangeWhere(dateFrom, dateTo);
  const basePaid = {
    paymentStatus: 'PAID',
    status: { notIn: ['CANCELLED'] },
    ...(createdAt ? { createdAt } : {}),
  };

  const [totalAgg, refundedAgg, refurbishedRow, newProductRow, refurbishedOrderCount, newProductOrderCount] =
    await Promise.all([
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
  };
}

/** Single aggregate for the admin dashboard KPI tiles + alert banners. */
export async function getDashboardOverview(actor = null) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const inspectionStatuses = ['REQUESTED', 'RECEIVED', 'UNDER_INSPECTION'];

  const { productService } = await import('./product.service.js');
  const { inventoryService } = await import('./inventory.service.js');
  const { canAccessRouteModule } = await import('../constants/admin-modules.js');

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
  const wantInspection = can('inspection') || can('returns');

  const [
    newProductStats,
    refurbishedStats,
    inventoryStats,
    totalOrders,
    pendingOrders,
    ordersThisMonth,
    registeredCustomers,
    activeMembers,
    pendingInspections,
    queuedInspectionsToday,
  ] = await Promise.all([
    wantProducts ? productService.getAdminProductStats('NEW') : Promise.resolve({ total: null }),
    wantProducts || can('refurbished')
      ? productService.getAdminProductStats('REFURBISHED')
      : Promise.resolve({ total: null }),
    wantInventory ? inventoryService.getStats() : Promise.resolve({ criticalUnderThreshold: null }),
    wantOrders ? prisma.order.count() : Promise.resolve(null),
    wantOrders
      ? prisma.order.count({ where: buildLegacyAdminPendingCountWhere() })
      : Promise.resolve(null),
    wantOrders
      ? prisma.order.count({ where: { createdAt: { gte: monthStart } } })
      : Promise.resolve(null),
    wantCustomers
      ? prisma.user.count({ where: { role: { name: { in: ['CUSTOMER', 'USER'] } } } })
      : Promise.resolve(null),
    wantAccess
      ? prisma.user.count({ where: { accessMemberUntil: { gt: now } } })
      : Promise.resolve(null),
    wantInspection
      ? prisma.returnRequest.count({
          where: { type: 'REFURBISHMENT', status: { in: inspectionStatuses } },
        })
      : Promise.resolve(null),
    wantInspection
      ? prisma.returnRequest.count({
          where: { status: 'UNDER_INSPECTION', createdAt: { gte: todayStart } },
        })
      : Promise.resolve(null),
  ]);

  return {
    totalProductsNew: wantProducts ? newProductStats.total : null,
    totalRefurbished: wantProducts || can('refurbished') ? refurbishedStats.total : null,
    totalOrders: wantOrders ? totalOrders : null,
    pendingOrders: wantOrders ? pendingOrders : null,
    pendingFulfillment: wantOrders ? pendingOrders : null,
    ordersThisMonth: wantOrders ? ordersThisMonth : null,
    registeredCustomers: wantCustomers ? registeredCustomers : null,
    activeMembers: wantAccess ? activeMembers : null,
    pendingInspections: wantInspection ? pendingInspections : null,
    queuedInspectionsToday: wantInspection ? queuedInspectionsToday : null,
    lowStockCount: wantInventory ? inventoryStats.criticalUnderThreshold : null,
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

export async function listCustomers(page = 1, limit = 20, { search, role } = {}) {
  const skip = (page - 1) * limit;
  const and = [];
  if (role && String(role).trim()) {
    and.push({ role: { name: String(role).trim() } });
  } else {
    and.push({ role: { name: { in: ['CUSTOMER', 'USER'] } } });
  }
  if (search && String(search).trim()) {
    const q = String(search).trim();
    and.push({
      OR: [
        { email: { contains: q, mode: 'insensitive' } },
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
      ],
    });
  }
  const where = { AND: and };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        publicId: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        isActive: true,
        isGuest: true,
        accessMemberUntil: true,
        createdAt: true,
        role: { select: { name: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    customers: users,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
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
  let where = {};
  if (filter === 'active') {
    where = { accessMemberUntil: { gt: now } };
  } else if (filter === 'expired') {
    where = { accessMemberUntil: { not: null, lte: now } };
  } else {
    where = { accessMemberUntil: { not: null } };
  }

  const users = await prisma.user.findMany({
    where,
    orderBy: { accessMemberUntil: 'desc' },
    select: {
      id: true,
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      accessMemberUntil: true,
      createdAt: true,
    },
  });

  return { members: users };
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

export async function listAdminTeamMembers(actorPublicId) {
  void actorPublicId;
  const role = await prisma.role.findUnique({ where: { name: 'ADMIN_TEAM' } });
  if (!role) return { members: [] };
  const users = await prisma.user.findMany({
    where: { roleId: role.id },
    orderBy: { email: 'asc' },
    select: {
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      adminModules: true,
      adminNotificationAccess: true,
      isActive: true,
      createdAt: true,
    },
  });
  return {
    members: users.map((user) => ({
      ...user,
      roleTitle: user.phone || null,
    })),
  };
}

export async function createAdminTeamMember(actorPublicId, payload) {
  await assertActorIsAdmin(actorPublicId);
  const teamRole = await prisma.role.findUnique({ where: { name: 'ADMIN_TEAM' } });
  if (!teamRole) throw new AppError(500, 'ADMIN_TEAM role missing');

  const email = String(payload.email || '').trim().toLowerCase();
  const tempPassword = `Bb!${Math.random().toString(36).slice(2, 8)}${Math.floor(Math.random() * 90 + 10)}`;
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

  const normalized = normalizeTeamPermissionModules(modules);
  if (!normalized || normalized.length === 0) {
    throw new AppError(400, 'At least one module permission is required');
  }

  const hashed = await bcrypt.hash(tempPassword, 10);
  let created;
  try {
    created = await prisma.user.create({
      data: {
        email,
        password: hashed,
        firstName,
        lastName,
        phone: roleTitle,
        roleId: teamRole.id,
        portalScope: PORTAL_SCOPE.STAFF,
        adminModules: normalized,
        adminNotificationAccess,
        emailVerifiedAt: new Date(),
        isActive: true,
      },
      select: {
        publicId: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        adminModules: true,
        adminNotificationAccess: true,
        isActive: true,
        createdAt: true,
      },
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
    meta: { modules: normalized, roleTitle, adminNotificationAccess },
  });
  try {
    await emailService.sendTemplate({
      to: created.email,
      template: 'team-invite',
      context: {
        name: [created.firstName, created.lastName].filter(Boolean).join(' ') || created.email,
        email: created.email,
        temporaryPassword: tempPassword,
        roleTitle: roleTitle || 'Team Member',
        loginUrl: `${config.frontend.adminUrl}/auth/login`,
      },
    });
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
    ...created,
    roleTitle: created.phone || null,
  };
}

export async function setTeamMemberModules(actorPublicId, targetPublicId, modules) {
  await assertActorIsAdmin(actorPublicId);
  const teamRole = await prisma.role.findUnique({ where: { name: 'ADMIN_TEAM' } });
  if (!teamRole) throw new AppError(500, 'ADMIN_TEAM role missing');

  const normalized = normalizeTeamPermissionModules(modules);
  if (!normalized || normalized.length === 0) {
    throw new AppError(400, 'At least one module permission is required');
  }

  const target = await prisma.user.findUnique({
    where: { publicId: targetPublicId },
    select: { id: true, roleId: true },
  });
  if (!target || target.roleId !== teamRole.id) {
    throw new AppError(404, 'Team member not found');
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { adminModules: normalized },
    select: {
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      adminModules: true,
      adminNotificationAccess: true,
      isActive: true,
      createdAt: true,
    },
  });
  await writeAdminAudit({
    actorId: actorPublicId,
    action: 'TEAM_MODULES_UPDATED',
    entityType: 'User',
    entityId: updated.publicId,
    meta: { modules: normalized },
  });
  return {
    ...updated,
    roleTitle: updated.phone || null,
  };
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
  if (payload.roleTitle !== undefined) data.phone = payload.roleTitle ? String(payload.roleTitle).trim() : null;
  if (payload.isActive !== undefined) data.isActive = Boolean(payload.isActive);
  if (payload.adminNotificationAccess !== undefined) {
    data.adminNotificationAccess = Boolean(payload.adminNotificationAccess);
  }
  if (payload.modules !== undefined) {
    const normalizedModules = normalizeTeamPermissionModules(payload.modules);
    if (!normalizedModules || normalizedModules.length === 0) {
      throw new AppError(400, 'At least one module permission is required');
    }
    data.adminModules = normalizedModules;
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data,
    select: {
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      adminModules: true,
      adminNotificationAccess: true,
      isActive: true,
      createdAt: true,
    },
  });
  await writeAdminAudit({
    actorId: actorPublicId,
    action: 'TEAM_MEMBER_UPDATED',
    entityType: 'User',
    entityId: updated.publicId,
    meta: {
      firstName: updated.firstName,
      lastName: updated.lastName,
      roleTitle: updated.phone || null,
      isActive: updated.isActive,
      modules: updated.adminModules,
      adminNotificationAccess: updated.adminNotificationAccess,
    },
  });
  return {
    ...updated,
    roleTitle: updated.phone || null,
  };
}
