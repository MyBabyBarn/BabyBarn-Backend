import { prisma } from '../lib/prisma.js';

/**
 * REQ-08: keep guest data 45 days, then soft-delete (hidden from customer track;
 * still visible to admin). Measured from the guest's most recent order.
 */
export const GUEST_RETENTION_DAYS = Number(process.env.GUEST_RETENTION_DAYS ?? 45);

/**
 * Soft-delete stale guest accounts for customer-facing visibility.
 *
 * A guest qualifies when it is an unconverted guest, has not already been soft-deleted,
 * and its most recent order is older than the retention window. We set guestPurgedAt so
 * guest tracking hides the account, but we keep name/email/phone/addresses for admin.
 */
export async function purgeExpiredGuestData() {
  const cutoff = new Date(Date.now() - GUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await prisma.user.findMany({
    where: {
      isGuest: true,
      convertedAt: null,
      guestPurgedAt: null,
    },
    select: {
      id: true,
      orders: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  const expiredUserIds = candidates
    .filter((u) => {
      const latest = u.orders[0]?.createdAt;
      if (!latest) return false;
      return new Date(latest) < cutoff;
    })
    .map((u) => u.id);

  if (expiredUserIds.length === 0) {
    return { scanned: candidates.length, purged: 0 };
  }

  let purged = 0;
  for (const userId of expiredUserIds) {
    await prisma.user.update({
      where: { id: userId },
      data: { guestPurgedAt: new Date() },
    });
    purged += 1;
  }

  return { scanned: candidates.length, purged };
}
