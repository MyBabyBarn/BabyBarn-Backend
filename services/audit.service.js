import { prisma } from '../lib/prisma.js';
import { rowsToCsv } from '../lib/csv-safe.js';

function buildAuditWhere(filters = {}) {
  const and = [];
  const search = filters.search ? String(filters.search).trim() : '';
  if (search) {
    and.push({
      OR: [
        { actorEmail: { contains: search, mode: 'insensitive' } },
        { action: { contains: search, mode: 'insensitive' } },
        { entityType: { contains: search, mode: 'insensitive' } },
        { entityId: { contains: search, mode: 'insensitive' } },
      ],
    });
  }
  if (filters.action) {
    and.push({ action: { equals: String(filters.action), mode: 'insensitive' } });
  }
  if (filters.entityType) {
    and.push({ entityType: { equals: String(filters.entityType), mode: 'insensitive' } });
  }
  if (filters.entityId) {
    and.push({ entityId: { equals: String(filters.entityId) } });
  }
  if (filters.actorEmail) {
    and.push({ actorEmail: { contains: String(filters.actorEmail), mode: 'insensitive' } });
  }
  if (filters.dateFrom) {
    const from = new Date(String(filters.dateFrom));
    if (!Number.isNaN(from.getTime())) and.push({ createdAt: { gte: from } });
  }
  if (filters.dateTo) {
    const to = new Date(String(filters.dateTo));
    if (!Number.isNaN(to.getTime())) {
      to.setHours(23, 59, 59, 999);
      and.push({ createdAt: { lte: to } });
    }
  }
  return and.length ? { AND: and } : {};
}

export async function writeAdminAudit({ actorId, actorEmail, action, entityType, entityId, meta }) {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorId: actorId ?? null,
        actorEmail: actorEmail ?? null,
        action,
        entityType,
        entityId: String(entityId),
        meta: meta ?? undefined,
      },
    });
  } catch (e) {
    console.error('[audit] write failed', action, e);
  }
}

export async function listOrderActivity(orderPublicId, limit = 100) {
  const order = await prisma.order.findUnique({
    where: { publicId: String(orderPublicId) },
    select: {
      id: true,
      publicId: true,
      returnRequests: {
        select: {
          publicId: true,
          submissionPublicId: true,
          returnNumber: true,
          type: true,
          status: true,
          createdAt: true,
          orderItem: {
            select: {
              publicId: true,
              product: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  const rows = await prisma.adminAuditLog.findMany({
    where: {
      OR: [
        { entityType: 'Order', entityId: String(orderPublicId) },
        {
          entityType: 'OrderItem',
          meta: { path: ['orderPublicId'], equals: String(orderPublicId) },
        },
      ],
    },
    take: Math.min(limit, 200),
    orderBy: { createdAt: 'desc' },
  });

  const returnsBySubmission = new Map();
  for (const rr of order?.returnRequests || []) {
    const submissionId = rr.submissionPublicId || rr.publicId;
    if (!submissionId) continue;
    let entry = returnsBySubmission.get(submissionId);
    if (!entry) {
      entry = {
        id: submissionId,
        returnNumber: rr.returnNumber || null,
        type: rr.type || 'STANDARD',
        status: rr.status || null,
        createdAt: rr.createdAt || null,
        lineIds: [],
        productNames: [],
      };
      returnsBySubmission.set(submissionId, entry);
    }
    if (rr.returnNumber && !entry.returnNumber) entry.returnNumber = rr.returnNumber;
    if (rr.status) entry.status = rr.status;
    const lineId = rr.orderItem?.publicId;
    if (lineId && !entry.lineIds.includes(lineId)) entry.lineIds.push(lineId);
    const productName = rr.orderItem?.product?.name;
    if (productName && !entry.productNames.includes(productName)) {
      entry.productNames.push(productName);
    }
  }

  return {
    logs: rows,
    returns: [...returnsBySubmission.values()],
  };
}

async function attachActorNames(rows) {
  const actorIds = [...new Set(rows.map((row) => row.actorId).filter(Boolean))];
  if (actorIds.length === 0) {
    return rows.map((row) => ({
      ...row,
      actorFirstName: null,
      actorLastName: null,
      actorRole: null,
    }));
  }

  const actors = await prisma.user.findMany({
    where: { publicId: { in: actorIds } },
    select: {
      publicId: true,
      firstName: true,
      lastName: true,
      role: { select: { name: true } },
    },
  });
  const actorById = new Map(actors.map((actor) => [actor.publicId, actor]));

  return rows.map((row) => {
    const actor = row.actorId ? actorById.get(row.actorId) : null;
    return {
      ...row,
      actorFirstName: actor?.firstName ?? null,
      actorLastName: actor?.lastName ?? null,
      actorRole: actor?.role?.name ?? null,
    };
  });
}

export async function listAuditLogs(page = 1, limit = 50, filters = {}) {
  const skip = (page - 1) * limit;
  const where = buildAuditWhere(filters);
  const [rows, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.adminAuditLog.count({ where }),
  ]);
  const logs = await attachActorNames(rows);
  return {
    logs,
    pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit) || 1) },
  };
}

export async function exportAuditLogs(filters = {}, limit = 5000) {
  const where = buildAuditWhere(filters);
  return prisma.adminAuditLog.findMany({
    where,
    take: Math.min(limit, 10000),
    orderBy: { createdAt: 'desc' },
  });
}

export function auditLogsToCsv(rows) {
  const header = ['createdAt', 'actorEmail', 'action', 'entityType', 'entityId', 'meta'];
  const data = rows.map((row) => [
    row.createdAt?.toISOString?.() ?? row.createdAt,
    row.actorEmail ?? '',
    row.action,
    row.entityType,
    row.entityId,
    row.meta != null ? JSON.stringify(row.meta) : '',
  ]);
  return rowsToCsv(header, data);
}
