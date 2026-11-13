import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { getBusinessSettings, updateBusinessSettings } from './admin.service.js';
import { writeAdminAudit } from './audit.service.js';

function ownerName(user) {
  const first = user.firstName?.trim() || 'Member';
  const last = user.lastName?.trim();
  return last ? `${first} ${last.charAt(0)}.` : first;
}

function startOfUtcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getSharingSettings() {
  const settings = await getBusinessSettings();
  return {
    enabled: settings.membershipSharingEnabled !== false,
    maxUsers: Number(settings.membershipShareMaxUsers || 0),
    maxPerDay: Number(settings.membershipShareMaxPerDay || 0),
    maxPerMonth: Number(settings.membershipShareMaxPerMonth || 0),
    maxPerYear: Number(settings.membershipShareMaxPerYear || 0),
  };
}

async function usageCounts(ownerId, yearStart) {
  const now = new Date();
  const paid = { sharedAccessOwnerId: ownerId, paymentStatus: 'PAID' };
  const [users, dayCount, monthCount, yearCount, savings] = await Promise.all([
    prisma.order.findMany({ where: paid, distinct: ['userId'], select: { userId: true } }),
    prisma.order.count({ where: { ...paid, createdAt: { gte: startOfUtcDay(now) } } }),
    prisma.order.count({ where: { ...paid, createdAt: { gte: startOfUtcMonth(now) } } }),
    prisma.order.count({ where: { ...paid, createdAt: { gte: yearStart } } }),
    prisma.order.aggregate({ where: paid, _sum: { sharedAccessDiscount: true }, _count: { _all: true } }),
  ]);
  return {
    userIds: users.map((row) => row.userId),
    dayCount,
    monthCount,
    yearCount,
    orderCount: savings._count._all,
    savings: Number(savings._sum.sharedAccessDiscount || 0),
  };
}

const OWNER_SELECT = {
  id: true,
  publicId: true,
  firstName: true,
  lastName: true,
  accessNumber: true,
  accessMemberUntil: true,
};

function membershipUntil(owner) {
  return owner.accessMemberUntil ? new Date(owner.accessMemberUntil) : null;
}

async function rejectIneligibleBuyer(owner, buyerUserId) {
  if (buyerUserId && owner.id === buyerUserId) {
    throw new AppError(400, 'This is your own membership number', 'SHARE_OWN_CODE');
  }
  if (!buyerUserId) return;
  const buyer = await prisma.user.findUnique({
    where: { id: buyerUserId },
    select: { accessMemberUntil: true },
  });
  if (buyer?.accessMemberUntil && new Date(buyer.accessMemberUntil) > new Date()) {
    throw new AppError(400, 'Your own membership already applies', 'SHARE_ALREADY_MEMBER');
  }
}

async function enforceOwnerCaps(owner, buyerUserId, settings, until) {
  const yearStart = new Date(until);
  yearStart.setUTCFullYear(yearStart.getUTCFullYear() - 1);
  const usage = await usageCounts(owner.id, yearStart);
  const isNewUser = Boolean(buyerUserId) && !usage.userIds.includes(buyerUserId);
  if (settings.maxUsers > 0 && isNewUser && usage.userIds.length >= settings.maxUsers) {
    throw new AppError(400, 'This membership has reached its user limit', 'SHARE_USER_LIMIT');
  }
  if (settings.maxPerDay > 0 && usage.dayCount >= settings.maxPerDay) {
    throw new AppError(400, 'This membership has reached its daily order limit', 'SHARE_DAY_LIMIT');
  }
  if (settings.maxPerMonth > 0 && usage.monthCount >= settings.maxPerMonth) {
    throw new AppError(400, 'This membership has reached its monthly order limit', 'SHARE_MONTH_LIMIT');
  }
  if (settings.maxPerYear > 0 && usage.yearCount >= settings.maxPerYear) {
    throw new AppError(400, 'This membership has reached its yearly order limit', 'SHARE_YEAR_LIMIT');
  }
}

function shareResult(owner, until, enteredCode, codeId) {
  return {
    ownerId: owner.id,
    codeId: codeId ?? null,
    accessNumber: enteredCode,
    ownerName: ownerName(owner),
    status: 'active',
    expiresAt: until.toISOString(),
  };
}

async function resolveFromShareCode(shareCode, buyerUserId, settings) {
  if (shareCode.revokedAt) {
    throw new AppError(400, 'This code is no longer active', 'SHARE_REVOKED');
  }
  const owner = shareCode.owner;
  const until = membershipUntil(owner);
  if (!until || until <= new Date()) {
    throw new AppError(400, 'This membership has expired', 'SHARE_EXPIRED');
  }
  if (shareCode.expiresAt && new Date(shareCode.expiresAt) <= new Date()) {
    throw new AppError(400, 'This code has expired', 'SHARE_CODE_EXPIRED');
  }
  if (shareCode.useMode === 'ONE_TIME') {
    const used = await prisma.order.count({
      where: { sharedAccessCodeId: shareCode.id, paymentStatus: 'PAID' },
    });
    if (used > 0) throw new AppError(400, 'This code has already been used', 'SHARE_CODE_USED');
  } else if (shareCode.useMode !== 'MULTIPLE') {
    throw new AppError(500, 'Unknown share code use mode');
  }
  await rejectIneligibleBuyer(owner, buyerUserId);
  await enforceOwnerCaps(owner, buyerUserId, settings, until);
  const codeUntil = shareCode.expiresAt && new Date(shareCode.expiresAt) < until
    ? new Date(shareCode.expiresAt)
    : until;
  return shareResult(owner, codeUntil, shareCode.code, shareCode.id);
}

export async function resolveSharedMembership(code, buyerUserId) {
  const settings = await getSharingSettings();
  if (!settings.enabled) {
    throw new AppError(400, 'Membership sharing is turned off', 'SHARE_DISABLED');
  }
  const raw = String(code || '').trim();
  if (!raw) throw new AppError(400, 'Enter a membership number', 'SHARE_REQUIRED');

  const shareCode = await prisma.membershipShareCode.findFirst({
    where: { code: { equals: raw, mode: 'insensitive' } },
    include: { owner: { select: OWNER_SELECT } },
  });
  if (shareCode) return resolveFromShareCode(shareCode, buyerUserId, settings);

  const owner = await prisma.user.findFirst({
    where: { accessNumber: { equals: raw, mode: 'insensitive' } },
    select: OWNER_SELECT,
  });
  if (!owner?.accessNumber) throw new AppError(404, 'Membership number not found', 'SHARE_NOT_FOUND');
  const until = membershipUntil(owner);
  if (!until || until <= new Date()) {
    throw new AppError(400, 'This membership has expired', 'SHARE_EXPIRED');
  }
  await rejectIneligibleBuyer(owner, buyerUserId);
  await enforceOwnerCaps(owner, buyerUserId, settings, until);
  return shareResult(owner, until, owner.accessNumber, null);
}

export async function assertShareCodeAvailableForPayment(tx, codeId) {
  if (!codeId) return;
  await tx.$queryRaw`SELECT id FROM "MembershipShareCode" WHERE id = ${codeId} FOR UPDATE`;
  const shareCode = await tx.membershipShareCode.findUnique({ where: { id: codeId } });
  if (!shareCode || shareCode.revokedAt) {
    throw new AppError(409, 'This code is no longer active', 'SHARE_REVOKED');
  }
  if (shareCode.expiresAt && new Date(shareCode.expiresAt) <= new Date()) {
    throw new AppError(409, 'This code has expired', 'SHARE_CODE_EXPIRED');
  }
  if (shareCode.useMode === 'ONE_TIME') {
    const used = await tx.order.count({
      where: { sharedAccessCodeId: shareCode.id, paymentStatus: 'PAID' },
    });
    if (used > 0) throw new AppError(409, 'This code has already been used', 'SHARE_CODE_USED');
    return;
  }
  if (shareCode.useMode === 'MULTIPLE') return;
  throw new AppError(500, 'Unknown share code use mode');
}

export async function getMemberShareSummary(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { accessNumber: true, accessMemberUntil: true, firstName: true, lastName: true },
  });
  if (!user?.accessNumber) throw new AppError(404, 'No membership number on this account');
  const until = user.accessMemberUntil ? new Date(user.accessMemberUntil) : null;
  const active = Boolean(until && until > new Date());
  const yearStart = until ? new Date(until) : new Date();
  if (until) yearStart.setUTCFullYear(yearStart.getUTCFullYear() - 1);
  const usage = await usageCounts(userId, yearStart);
  const settings = await getSharingSettings();
  const codes = await listMemberShareCodes(userId);
  return {
    accessNumber: user.accessNumber,
    status: active ? 'active' : 'expired',
    expiresAt: until ? until.toISOString() : null,
    sharingEnabled: settings.enabled && active,
    uniqueUsers: usage.userIds.length,
    orderCount: usage.orderCount,
    totalSavings: usage.savings,
    limits: settings,
    codes,
  };
}

async function listMemberShareCodes(userId) {
  const codes = await prisma.membershipShareCode.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: 'desc' },
  });
  if (!codes.length) return [];
  const counts = await prisma.order.groupBy({
    by: ['sharedAccessCodeId'],
    where: { sharedAccessCodeId: { in: codes.map((code) => code.id) }, paymentStatus: 'PAID' },
    _count: { _all: true },
  });
  const paidById = new Map(counts.map((row) => [row.sharedAccessCodeId, row._count._all]));
  return codes.map((code) => ({
    id: code.publicId,
    code: code.code,
    noteEmail: code.noteEmail,
    expiresAt: code.expiresAt ? code.expiresAt.toISOString() : null,
    useMode: code.useMode,
    revokedAt: code.revokedAt ? code.revokedAt.toISOString() : null,
    paidUses: paidById.get(code.id) || 0,
  }));
}

function endOfUtcDay(dateValue) {
  const day = String(dateValue || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return new Date(`${day}T23:59:59.999Z`);
}

function newShareCodeValue() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let body = '';
  for (let i = 0; i < 8; i += 1) body += alphabet[bytes[i] % alphabet.length];
  return `SC-${body.slice(0, 4)}-${body.slice(4)}`;
}

async function requireSharingOwner(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, accessNumber: true, accessMemberUntil: true },
  });
  if (!user?.accessNumber) throw new AppError(404, 'No membership number on this account');
  const until = membershipUntil(user);
  if (!until || until <= new Date()) {
    throw new AppError(400, 'This membership has expired', 'SHARE_EXPIRED');
  }
  const settings = await getSharingSettings();
  if (!settings.enabled) throw new AppError(400, 'Membership sharing is turned off', 'SHARE_DISABLED');
  return { user, until };
}

export async function createMemberShareCode(userId, body) {
  const { until } = await requireSharingOwner(userId);
  const useMode = body?.useMode === 'ONE_TIME' ? 'ONE_TIME' : body?.useMode === 'MULTIPLE' ? 'MULTIPLE' : null;
  if (!useMode) throw new AppError(400, 'Choose one-time or multiple use');
  const note = String(body?.noteEmail || '').trim().toLowerCase();
  if (note && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(note)) {
    throw new AppError(400, 'Enter a valid email note');
  }
  let expiresAt = null;
  if (body?.expiresOn) {
    expiresAt = endOfUtcDay(body.expiresOn);
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new AppError(400, 'Choose an expiry date in the future');
    }
    if (expiresAt > until) {
      throw new AppError(400, 'Expiry cannot be later than the membership end date');
    }
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const created = await prisma.membershipShareCode.create({
        data: {
          ownerId: userId,
          code: newShareCodeValue(),
          noteEmail: note || null,
          expiresAt,
          useMode,
        },
      });
      return {
        id: created.publicId,
        code: created.code,
        noteEmail: created.noteEmail,
        expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
        useMode: created.useMode,
        revokedAt: null,
        paidUses: 0,
      };
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
    }
  }
  throw new AppError(500, 'Could not create a share code');
}

export async function setMemberShareCodeActive(userId, publicId, active) {
  await requireSharingOwner(userId);
  const code = await prisma.membershipShareCode.findFirst({
    where: { publicId: String(publicId), ownerId: userId },
  });
  if (!code) throw new AppError(404, 'Share code not found');
  const revokedAt = active ? null : code.revokedAt || new Date();
  if (Boolean(code.revokedAt) === active) {
    await prisma.membershipShareCode.update({
      where: { id: code.id },
      data: { revokedAt },
    });
  }
  return { id: code.publicId, active, revokedAt: revokedAt ? revokedAt.toISOString() : null };
}

export async function revokeMemberShareCode(userId, publicId) {
  return setMemberShareCodeActive(userId, publicId, false);
}

export async function getMemberShareHistory(userId) {
  const orders = await prisma.order.findMany({
    where: { sharedAccessOwnerId: userId, paymentStatus: 'PAID' },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      user: { select: { firstName: true, lastName: true } },
      orderItems: { include: { product: { select: { name: true } } } },
    },
  });
  return orders.map((order) => ({
    orderNumber: order.orderNumber,
    userName: ownerName(order.user),
    purchasedAt: order.createdAt,
    products: order.orderItems.map((line) => line.product?.name).filter(Boolean),
    code: order.sharedAccessNumber,
    discount: Number(order.sharedAccessDiscount || 0),
    orderValue: Number(order.totalAmount || 0),
  }));
}

export async function listAdminSharing() {
  const owners = await prisma.user.findMany({
    where: { accessNumber: { not: null } },
    select: {
      publicId: true,
      firstName: true,
      lastName: true,
      accessNumber: true,
      accessMemberUntil: true,
      _count: { select: { membershipShareCodes: true } },
      sharedAccessOrders: {
        where: { paymentStatus: 'PAID' },
        select: { userId: true, sharedAccessDiscount: true },
      },
    },
  });
  return owners.map((owner) => {
    const until = owner.accessMemberUntil ? new Date(owner.accessMemberUntil) : null;
    const users = new Set(owner.sharedAccessOrders.map((order) => order.userId));
    const discount = owner.sharedAccessOrders.reduce((sum, order) => sum + Number(order.sharedAccessDiscount || 0), 0);
    return {
      id: owner.publicId,
      accessNumber: owner.accessNumber,
      ownerName: ownerName(owner),
      status: until && until > new Date() ? 'active' : 'expired',
      usageCount: owner.sharedAccessOrders.length,
      uniqueUsers: users.size,
      totalDiscount: discount,
      codeCount: owner._count.membershipShareCodes,
    };
  });
}

export async function getAdminShareDetail(userPublicId) {
  const owner = await prisma.user.findUnique({
    where: { publicId: String(userPublicId || '').trim() },
    select: { id: true, publicId: true, email: true, firstName: true, lastName: true, accessNumber: true },
  });
  if (!owner?.accessNumber) throw new AppError(404, 'Membership not found');
  const [summary, orders] = await Promise.all([
    getMemberShareSummary(owner.id),
    getMemberShareHistory(owner.id),
  ]);
  const ownerNameFull = [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim() || owner.email;
  return {
    id: owner.publicId,
    ownerName: ownerNameFull,
    email: owner.email,
    accessNumber: summary.accessNumber,
    status: summary.status,
    expiresAt: summary.expiresAt,
    uniqueUsers: summary.uniqueUsers,
    orderCount: summary.orderCount,
    totalSavings: summary.totalSavings,
    codeCount: summary.codes.length,
    codes: summary.codes,
    orders,
  };
}

export async function listAdminSharingActivity() {
  const orders = await prisma.order.findMany({
    where: { sharedAccessOwnerId: { not: null }, paymentStatus: 'PAID' },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      publicId: true,
      orderNumber: true,
      userId: true,
      sharedAccessOwnerId: true,
      sharedAccessNumber: true,
      totalAmount: true,
      sharedAccessDiscount: true,
      createdAt: true,
      user: { select: { firstName: true, lastName: true, isGuest: true } },
      sharedAccessOwner: { select: { firstName: true, lastName: true, accessNumber: true } },
    },
  });
  return orders.map((order) => ({
    id: order.publicId,
    orderNumber: order.orderNumber,
    orderPublicId: order.publicId,
    ownerName: order.sharedAccessOwner ? ownerName(order.sharedAccessOwner) : '—',
    accessNumber: order.sharedAccessNumber || order.sharedAccessOwner?.accessNumber || null,
    userName: ownerName(order.user),
    isGuest: Boolean(order.user?.isGuest),
    shopperIsOwner: order.userId === order.sharedAccessOwnerId,
    purchaseValue: Number(order.totalAmount || 0),
    discount: Number(order.sharedAccessDiscount || 0),
    usedAt: order.createdAt,
  }));
}

export async function updateSharingSettings(user, body) {
  const data = await updateBusinessSettings({
    membershipSharingEnabled: body.enabled,
    membershipShareMaxUsers: body.maxUsers,
    membershipShareMaxPerDay: body.maxPerDay,
    membershipShareMaxPerMonth: body.maxPerMonth,
    membershipShareMaxPerYear: body.maxPerYear,
  });
  await writeAdminAudit({
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? null,
    action: 'MEMBERSHIP_SHARING_SETTINGS_UPDATED',
    entityType: 'BusinessSettings',
    entityId: '1',
    meta: body,
  });
  return {
    enabled: data.membershipSharingEnabled !== false,
    maxUsers: Number(data.membershipShareMaxUsers || 0),
    maxPerDay: Number(data.membershipShareMaxPerDay || 0),
    maxPerMonth: Number(data.membershipShareMaxPerMonth || 0),
    maxPerYear: Number(data.membershipShareMaxPerYear || 0),
  };
}
