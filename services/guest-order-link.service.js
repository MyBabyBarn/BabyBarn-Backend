import { prisma } from '../lib/prisma.js';
import {
  ACTIVE_RETURN_STATUSES,
  guestTrackCutoffDate,
} from '../lib/guest-order-visibility.js';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Re-attach guest-placed orders (by contactEmail) to a registered customer.
 * Only orders within the guest track window, or with an active return, are linked
 * (per product rules). Older guest orders remain on their shell for admin guest filters.
 *
 * @returns {Promise<number>} count of orders moved
 */
export async function linkEligibleGuestOrdersToUser(userId, email) {
  const contact = normalizeEmail(email);
  if (!userId || !contact) return 0;

  const cutoff = guestTrackCutoffDate();

  const candidates = await prisma.order.findMany({
    where: {
      contactEmail: { equals: contact, mode: 'insensitive' },
      OR: [{ placedAsGuest: true }, { user: { isGuest: true } }],
      NOT: { userId },
    },
    select: {
      id: true,
      createdAt: true,
      returnRequests: { select: { id: true, status: true } },
    },
  });

  let moved = 0;
  for (const order of candidates) {
    const hasActiveReturn = (order.returnRequests || []).some((r) =>
      ACTIVE_RETURN_STATUSES.includes(String(r.status || '').toUpperCase())
    );
    const inWindow = order.createdAt >= cutoff;
    if (!inWindow && !hasActiveReturn) continue;

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { userId, placedAsGuest: false },
      });
      await tx.returnRequest.updateMany({
        where: { orderId: order.id },
        data: { userId },
      });
    });
    moved += 1;
  }

  return moved;
}

/**
 * Whether a guest-track lookup may display this order.
 */
export async function assertGuestTrackVisible(order) {
  if (!order) return false;

  // REQ-08: soft-deleted guests stay visible to admin but not guest track.
  if (order.userId) {
    const owner = await prisma.user.findUnique({
      where: { id: order.userId },
      select: { isGuest: true, guestPurgedAt: true, convertedAt: true },
    });
    if (owner?.isGuest && !owner.convertedAt && owner.guestPurgedAt) {
      return false;
    }
  }

  const cutoff = guestTrackCutoffDate();
  if (order.createdAt >= cutoff) return true;

  const active = await prisma.returnRequest.findFirst({
    where: {
      orderId: order.id,
      status: { in: ACTIVE_RETURN_STATUSES },
    },
    select: { id: true },
  });
  return Boolean(active);
}
