import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { getBusinessSettings } from './admin.service.js';
import { emailService } from './email.service.js';
import { config } from '../config/env.js';
import { usAddressSchema } from '../schemas/index.js';
import { authService } from './auth.service.js';

export function validateMembershipRegistration(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new AppError(400, 'Registration details are required');
  }
  const babyName = String(payload.babyName || '').trim();
  if (!babyName) throw new AppError(400, 'Baby name is required');

  const parsed = usAddressSchema.safeParse({
    ...(payload.shippingAddress || {}),
    fullName: payload.shippingAddress?.fullName || babyName,
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || 'Invalid shipping address';
    throw new AppError(400, msg);
  }

  return {
    babyName,
    shippingAddress: {
      ...parsed.data,
      company: parsed.data.company || null,
      addressLine2: parsed.data.addressLine2 || null,
    },
  };
}

export async function getPublicBusinessSettings() {
  const settings = await getBusinessSettings();
  return {
    accessMembershipPriceUsd: settings.accessMembershipPriceUsd,
    accessMembershipPriceLabel: `$${Number(settings.accessMembershipPriceUsd).toFixed(0)}`,
    accessUsedReturnWindowDays: settings.accessUsedReturnWindowDays ?? 365,
  };
}

async function generateUniqueAccessNumber() {
  // SEC-19: unguessable member numbers (not a 5-digit Math.random space).
  for (let attempt = 0; attempt < 20; attempt++) {
    const accessNumber = `BB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const exists = await prisma.user.findFirst({
      where: { accessNumber },
      select: { id: true },
    });
    if (!exists) return accessNumber;
  }
  throw new AppError(500, 'Could not generate Farmhouse Friends member number');
}

export async function saveMembershipRegistration(userPublicId, payload) {
  const data = validateMembershipRegistration(payload);
  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: { id: true, email: true },
  });
  if (!user) throw new AppError(401, 'Unauthorized');

  await prisma.user.update({
    where: { id: user.id },
    data: {
      babyName: data.babyName,
      membershipShippingAddressJson: data.shippingAddress,
    },
  });

  // Match-or-create into Address Book so checkout can reuse the ACCESS shipping address
  // without overwriting an unrelated default address.
  const shipping = data.shippingAddress;
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const matchesShipping = (row) =>
    norm(row.fullName) === norm(shipping.fullName) &&
    norm(row.addressLine1 ?? row.street) === norm(shipping.addressLine1) &&
    norm(row.addressLine2) === norm(shipping.addressLine2) &&
    norm(row.city) === norm(shipping.city) &&
    norm(row.state) === norm(shipping.state) &&
    norm(row.zipCode) === norm(shipping.zipCode) &&
    norm(row.country || 'US') === norm(shipping.country || 'US') &&
    norm(row.phoneNumber) === norm(shipping.phoneNumber);

  const existingRows = await prisma.address.findMany({
    where: { userId: user.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  const match = existingRows.find(matchesShipping);

  if (match) {
    if (!match.isDefault) {
      await authService.updateAddress(userPublicId, match.publicId, { isDefault: true });
    }
  } else {
    await authService.createAddress(userPublicId, {
      ...shipping,
      isDefault: true,
    });
  }

  return { saved: true };
}

export async function completeMembershipPayment(session) {
  const userPublicId = session.metadata?.userPublicId;
  if (!userPublicId) return { handled: true, error: 'missing userPublicId' };

  const amountUsd =
    typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
  const sessionId = session.id;

  const existingPayment = await prisma.membershipPayment.findFirst({
    where: { stripeSessionId: sessionId },
  });
  if (existingPayment) {
    return { handled: true, flow: 'membership', duplicate: true };
  }

  const days = parseInt(process.env.ACCESS_MEMBERSHIP_DAYS || '365', 10);
  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      accessNumber: true,
      accessMemberUntil: true,
      babyName: true,
    },
  });
  if (!user) return { handled: true, error: 'missing user' };

  const now = new Date();
  const wasActive = user.accessMemberUntil && user.accessMemberUntil > now;
  const base =
    user.accessMemberUntil && user.accessMemberUntil > now
      ? new Date(user.accessMemberUntil)
      : now;
  const until = new Date(base);
  until.setUTCDate(until.getUTCDate() + days);

  const accessNumber = user.accessNumber || (await generateUniqueAccessNumber());
  const paymentType = wasActive ? 'RENEWAL' : 'PURCHASE';

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        accessMemberUntil: until,
        accessNumber,
        accessRenewalReminderSentAt: null,
        accessOnboardingPending: false,
        ...(typeof session.customer === 'string' ? { stripeCustomerId: session.customer } : {}),
      },
    }),
    prisma.membershipPayment.create({
      data: {
        userId: user.id,
        type: paymentType,
        amount: amountUsd ?? (await getBusinessSettings()).accessMembershipPriceUsd,
        stripeSessionId: sessionId,
        accessValidUntil: until,
      },
    }),
  ]);

  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'there';
  const dashboardUrl = `${config.frontend.customerUrl}/dashboard/access`;
  const template = paymentType === 'RENEWAL' ? 'access-renewal' : 'access-purchase';

  try {
    await emailService.sendTemplate({
      to: user.email,
      template,
      context: {
        name,
        accessNumber,
        amount: `$${Number(amountUsd ?? 50).toFixed(2)}`,
        validUntil: until.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }),
        actionUrl: dashboardUrl,
      },
    });
  } catch (err) {
    console.error('[membership] email failed', err);
  }

  return { handled: true, flow: 'membership', paymentType, accessNumber };
}

/** ACCESS purchased in the same payment as an order checkout intent. */
export async function completeMembershipFromBundledCheckout({
  userId,
  userPublicId,
  amountUsd,
  stripeReferenceId,
  babyName,
  shippingAddress,
}) {
  const ref = String(stripeReferenceId || '').trim();
  if (ref) {
    const existingPayment = await prisma.membershipPayment.findFirst({
      where: { stripeSessionId: ref },
    });
    if (existingPayment) return existingPayment;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      accessNumber: true,
      accessMemberUntil: true,
      babyName: true,
    },
  });
  if (!user) return null;

  if (babyName || shippingAddress) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(babyName ? { babyName: String(babyName).trim() } : {}),
        ...(shippingAddress ? { membershipShippingAddressJson: shippingAddress } : {}),
      },
    });
  }

  const days = parseInt(process.env.ACCESS_MEMBERSHIP_DAYS || '365', 10);
  const now = new Date();
  const wasActive = user.accessMemberUntil && user.accessMemberUntil > now;
  const base =
    user.accessMemberUntil && user.accessMemberUntil > now
      ? new Date(user.accessMemberUntil)
      : now;
  const until = new Date(base);
  until.setUTCDate(until.getUTCDate() + days);

  const accessNumber = user.accessNumber || (await generateUniqueAccessNumber());
  const paymentType = wasActive ? 'RENEWAL' : 'PURCHASE';
  const settings = await getBusinessSettings();

  const membershipPayment = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        accessMemberUntil: until,
        accessNumber,
        accessRenewalReminderSentAt: null,
        accessOnboardingPending: false,
      },
    });
    return tx.membershipPayment.create({
      data: {
        userId: user.id,
        type: paymentType,
        amount: amountUsd > 0 ? amountUsd : settings.accessMembershipPriceUsd,
        stripeSessionId: ref || null,
        accessValidUntil: until,
      },
    });
  });

  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'there';
  try {
    await emailService.sendTemplate({
      to: user.email,
      template: paymentType === 'RENEWAL' ? 'access-renewal' : 'access-purchase',
      context: {
        name,
        accessNumber,
        amount: `$${Number(membershipPayment.amount).toFixed(2)}`,
        validUntil: until.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }),
        actionUrl: `${config.frontend.customerUrl}/dashboard/access`,
      },
    });
  } catch (err) {
    console.error('[membership] bundled checkout email failed', err);
  }

  return membershipPayment;
}

export async function listMembershipPaymentsForUser(userPublicId) {
  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: { id: true, accessNumber: true, accessMemberUntil: true, createdAt: true },
  });
  if (!user) throw new AppError(401, 'Unauthorized');

  const payments = await prisma.membershipPayment.findMany({
    where: { userId: user.id },
    orderBy: { paidAt: 'desc' },
    take: 50,
  });

  return {
    accessNumber: user.accessNumber,
    accessMemberUntil: user.accessMemberUntil,
    memberSince: user.createdAt,
    payments: payments.map((p) => ({
      id: p.publicId,
      type: p.type,
      amount: p.amount,
      currency: p.currency,
      paidAt: p.paidAt,
      accessValidUntil: p.accessValidUntil,
      stripeSessionId: p.stripeSessionId,
    })),
  };
}

export async function getAccessSavingsForUser(userPublicId) {
  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: { id: true, accessMemberUntil: true },
  });
  if (!user) throw new AppError(401, 'Unauthorized');

  const hasAccess = user.accessMemberUntil != null && user.accessMemberUntil > new Date();

  const wallet = await prisma.storeCreditWallet.findUnique({
    where: { userId: user.id },
    select: {
      balance: true,
      heldBalance: true,
      transactions: {
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { type: true, amount: true, note: true, createdAt: true },
      },
    },
  });

  const storeCreditBalance = Math.round(Number(wallet?.balance ?? 0) * 100) / 100;
  const storeCreditEarned =
    Math.round(
      (wallet?.transactions ?? [])
        .filter((t) => t.type === 'EARNED')
        .reduce((sum, t) => sum + Number(t.amount), 0) * 100
    ) / 100;
  const storeCreditRedeemed =
    Math.round(
      (wallet?.transactions ?? [])
        .filter((t) => t.type === 'REDEEMED')
        .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0) * 100
    ) / 100;
  const recentCredits = (wallet?.transactions ?? [])
    .filter((t) => t.type === 'EARNED')
    .slice(0, 10)
    .map((t) => ({
      amount: Math.round(Number(t.amount) * 100) / 100,
      note: t.note ?? 'Store credit',
      createdAt: t.createdAt,
    }));

  if (!hasAccess) {
    return {
      savingsTotal: 0,
      memberPricingSavings: 0,
      totalOrderValueInCycle: 0,
      orderCount: 0,
      channels: [],
      storeCreditBalance,
      storeCreditEarned,
      storeCreditRedeemed,
      recentCredits,
    };
  }

  const membershipDays = parseInt(process.env.ACCESS_MEMBERSHIP_DAYS || '365', 10);
  const cycleStart = new Date(user.accessMemberUntil);
  cycleStart.setUTCDate(cycleStart.getUTCDate() - membershipDays);

  const paidOrders = await prisma.order.findMany({
    where: {
      userId: user.id,
      paymentStatus: 'PAID',
      status: { notIn: ['CANCELLED'] },
      createdAt: { gte: cycleStart },
    },
    select: { totalAmount: true },
  });
  const totalOrderValueInCycle =
    Math.round(paidOrders.reduce((sum, order) => sum + Number(order.totalAmount), 0) * 100) / 100;

  const items = await prisma.orderItem.findMany({
    where: {
      order: {
        userId: user.id,
        paymentStatus: 'PAID',
        status: { notIn: ['CANCELLED'] },
      },
    },
    include: {
      product: {
        select: {
          price: true,
          memberPrice: true,
          productType: true,
        },
      },
    },
    take: 500,
  });

  let savingsTotal = 0;
  let memberPricingSavings = 0;
  const orderIds = new Set();

  for (const item of items) {
    const paid = Number(item.price);
    const retail = Number(item.product?.price ?? paid);
    const member = Number(item.product?.memberPrice ?? paid);
    const baseline = Math.max(retail, member);
    if (baseline > paid) {
      const saved = (baseline - paid) * item.quantity;
      savingsTotal += saved;
      memberPricingSavings += saved;
    }
    orderIds.add(item.orderId);
  }

  const memberPricingSavingsRounded = Math.round(memberPricingSavings * 100) / 100;

  return {
    savingsTotal: Math.round((savingsTotal + storeCreditEarned) * 100) / 100,
    memberPricingSavings: memberPricingSavingsRounded,
    totalOrderValueInCycle,
    orderCount: orderIds.size,
    channels: [
      {
        label: 'Member pricing',
        amount: memberPricingSavingsRounded,
      },
      {
        label: 'Store credit earned',
        amount: storeCreditEarned,
      },
    ],
    storeCreditBalance,
    storeCreditEarned,
    storeCreditRedeemed,
    recentCredits,
  };
}

export async function getMembershipRevenueStats({ dateFrom, dateTo } = {}) {
  const where = {};
  if (dateFrom || dateTo) {
    where.paidAt = {};
    if (dateFrom) where.paidAt.gte = new Date(dateFrom);
    if (dateTo) {
      const e = new Date(dateTo);
      e.setHours(23, 59, 59, 999);
      where.paidAt.lte = e;
    }
  }

  const agg = await prisma.membershipPayment.aggregate({
    where,
    _sum: { amount: true },
    _count: true,
  });

  return {
    membershipRevenue: agg._sum.amount ?? 0,
    membershipPaymentCount: agg._count,
  };
}

/** Send renewal reminders before expiry (once per term). Days-before list from ACCESS_RENEWAL_REMINDER_DAYS (default 14,0). */
export async function sendAccessRenewalReminders() {
  const now = new Date();
  const daysBeforeList = (config.accessRenewalReminderDays || [14, 0]).filter((d) => d >= 0);
  if (daysBeforeList.length === 0) return { sent: 0, checked: 0 };

  let sent = 0;
  let checked = 0;

  for (const daysBefore of daysBeforeList) {
    if (daysBefore === 0) {
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

      const users = await prisma.user.findMany({
        where: {
          accessMemberUntil: { gte: dayStart, lt: dayEnd },
          accessExpiryDayReminderSentAt: null,
          accessNumber: { not: null },
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          accessNumber: true,
          accessMemberUntil: true,
        },
        take: 100,
      });
      checked += users.length;

      for (const user of users) {
        const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'there';
        try {
          await emailService.sendTemplate({
            to: user.email,
            template: 'access-renewal-reminder',
            context: {
              name,
              accessNumber: user.accessNumber,
              daysUntilExpiry: 0,
              validUntil: user.accessMemberUntil.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              }),
              actionUrl: `${config.frontend.customerUrl}/dashboard/access/renew`,
            },
          });
          await prisma.user.update({
            where: { id: user.id },
            data: { accessExpiryDayReminderSentAt: now },
          });
          sent += 1;
        } catch (err) {
          console.error('[membership] expiry-day reminder failed', user.email, err);
        }
      }
      continue;
    }

    const windowStart = new Date(now);
    windowStart.setUTCDate(windowStart.getUTCDate() + daysBefore);
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);

    const users = await prisma.user.findMany({
      where: {
        accessMemberUntil: { gt: now, gte: windowStart, lt: windowEnd },
        accessRenewalReminderSentAt: null,
        accessNumber: { not: null },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        accessNumber: true,
        accessMemberUntil: true,
      },
      take: 100,
    });
    checked += users.length;

    for (const user of users) {
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'there';
      try {
        await emailService.sendTemplate({
          to: user.email,
          template: 'access-renewal-reminder',
          context: {
            name,
            accessNumber: user.accessNumber,
            daysUntilExpiry: daysBefore,
            validUntil: user.accessMemberUntil.toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            }),
            actionUrl: `${config.frontend.customerUrl}/dashboard/access/renew`,
          },
        });
        await prisma.user.update({
          where: { id: user.id },
          data: { accessRenewalReminderSentAt: now },
        });
        sent += 1;
      } catch (err) {
        console.error('[membership] renewal reminder failed', user.email, err);
      }
    }
  }

  return { sent, checked };
}

/** Notify members whose ACCESS expired in the last 24h (once). */
export async function sendAccessExpiredNotices() {
  const now = new Date();
  const dayAgo = new Date(now);
  dayAgo.setUTCDate(dayAgo.getUTCDate() - 1);

  const users = await prisma.user.findMany({
    where: {
      accessMemberUntil: { lte: now, gte: dayAgo },
      accessNumber: { not: null },
      accessExpiredNoticeSentAt: null,
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      accessMemberUntil: true,
    },
    take: 100,
  });

  let sent = 0;
  for (const user of users) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'there';
    try {
      await emailService.sendTemplate({
        to: user.email,
        template: 'access-expired',
        context: {
          name,
          validUntil: user.accessMemberUntil.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          }),
          actionUrl: `${config.frontend.customerUrl}/access`,
        },
      });
      await prisma.user.update({
        where: { id: user.id },
        data: { accessExpiredNoticeSentAt: now },
      });
      sent += 1;
    } catch (err) {
      console.error('[membership] access expired notice failed', user.email, err);
    }
  }

  return { sent, checked: users.length };
}
