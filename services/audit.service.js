import { prisma } from '../lib/prisma.js';
import { rowsToCsv } from '../lib/csv-safe.js';
import {
  AUDIT_MODULE_LABELS,
  auditActionOk,
  deriveAuditModule,
  formatAuditDetails,
  humanizeAuditAction,
  moduleFilterWhere,
} from '../lib/audit-module.js';

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
  if (filters.actorId) {
    and.push({ actorId: { equals: String(filters.actorId) } });
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

  const modWhere = moduleFilterWhere(filters.module);
  if (modWhere) and.push(modWhere);

  const result = filters.result ? String(filters.result) : '';
  if (result === 'ok') {
    and.push({
      AND: [
        { NOT: { action: { contains: 'FAILED', mode: 'insensitive' } } },
        { NOT: { action: { contains: 'ERROR', mode: 'insensitive' } } },
        { NOT: { action: { contains: 'DENIED', mode: 'insensitive' } } },
      ],
    });
  } else if (result === 'bad') {
    and.push({
      OR: [
        { action: { contains: 'FAILED', mode: 'insensitive' } },
        { action: { contains: 'ERROR', mode: 'insensitive' } },
        { action: { contains: 'DENIED', mode: 'insensitive' } },
      ],
    });
  }

  if (filters.excludeId) {
    and.push({ NOT: { publicId: String(filters.excludeId) } });
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
      actorRoleTitle: null,
    }));
  }

  const actors = await prisma.user.findMany({
    where: { publicId: { in: actorIds } },
    select: {
      publicId: true,
      firstName: true,
      lastName: true,
      roleTitle: true,
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
      actorRoleTitle: actor?.roleTitle ?? null,
    };
  });
}

function enrichLogRow(row) {
  const meta = row.meta && typeof row.meta === 'object' ? row.meta : null;
  const module = deriveAuditModule(row.entityType, row.action);
  const ok = auditActionOk(row.action);
  const name = [row.actorFirstName, row.actorLastName].filter(Boolean).join(' ').trim();
  return {
    ...row,
    id: row.publicId || row.id,
    module,
    moduleLabel: AUDIT_MODULE_LABELS[module] || 'System',
    ok,
    actionLabel: humanizeAuditAction(row.action, meta),
    details: formatAuditDetails(row.action, row.entityType, row.entityId, meta),
    ip: meta?.ip != null ? String(meta.ip) : null,
    userAgent: meta?.userAgent != null ? String(meta.userAgent) : null,
    changeField: meta?.field != null ? String(meta.field) : null,
    changeFrom: meta?.from != null ? String(meta.from) : null,
    changeTo: meta?.to != null ? String(meta.to) : null,
    actorDisplayName: name || row.actorEmail || 'System',
  };
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
  const withActors = await attachActorNames(rows);
  const logs = withActors.map(enrichLogRow);
  return {
    logs,
    pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit) || 1) },
  };
}

export async function getAuditLogById(publicId) {
  const row = await prisma.adminAuditLog.findFirst({
    where: {
      OR: [{ publicId: String(publicId) }, ...(Number(publicId) ? [{ id: Number(publicId) }] : [])],
    },
  });
  if (!row) return null;
  const [enriched] = await attachActorNames([row]);
  return enrichLogRow(enriched);
}

export async function listAuditLogFacets() {
  const recent = await prisma.adminAuditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 2000,
    select: { actorId: true, actorEmail: true, action: true },
  });

  const actions = [...new Set(recent.map((r) => r.action).filter(Boolean))].sort();
  const actorIds = [...new Set(recent.map((r) => r.actorId).filter(Boolean))];

  const users = actorIds.length
    ? await prisma.user.findMany({
        where: { publicId: { in: actorIds } },
        select: {
          publicId: true,
          email: true,
          firstName: true,
          lastName: true,
          role: { select: { name: true } },
        },
      })
    : [];

  const byId = new Map(users.map((u) => [u.publicId, u]));
  const actors = [];
  const seen = new Set();
  for (const row of recent) {
    const key = row.actorId || row.actorEmail || '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const u = row.actorId ? byId.get(row.actorId) : null;
    const name = u
      ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email
      : row.actorEmail || 'System';
    actors.push({
      publicId: row.actorId || null,
      email: u?.email || row.actorEmail || null,
      name,
      role: u?.role?.name || null,
    });
  }
  actors.sort((a, b) => a.name.localeCompare(b.name));

  return {
    actors,
    actions,
    modules: Object.entries(AUDIT_MODULE_LABELS).map(([id, label]) => ({ id, label })),
  };
}

export async function exportAuditLogs(filters = {}, limit = 5000) {
  const where = buildAuditWhere(filters);
  const rows = await prisma.adminAuditLog.findMany({
    where,
    take: Math.min(limit, 10000),
    orderBy: { createdAt: 'desc' },
  });
  const withActors = await attachActorNames(rows);
  return withActors.map(enrichLogRow);
}

export function auditLogsToCsv(rows) {
  const header = [
    'createdAt',
    'actorName',
    'actorEmail',
    'module',
    'action',
    'details',
    'entityType',
    'entityId',
    'ok',
    'ip',
  ];
  const data = rows.map((row) => [
    row.createdAt?.toISOString?.() ?? row.createdAt,
    row.actorDisplayName ?? '',
    row.actorEmail ?? '',
    row.moduleLabel ?? row.module ?? '',
    row.actionLabel ?? row.action,
    row.details ?? '',
    row.entityType,
    row.entityId,
    row.ok === false ? 'failed' : 'success',
    row.ip ?? '',
  ]);
  return rowsToCsv(header, data);
}
