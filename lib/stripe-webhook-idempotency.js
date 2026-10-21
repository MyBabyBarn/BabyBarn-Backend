/**
 * WS-A1 — Stripe webhook claim / complete / fail.
 * Event is only PROCESSED after the handler succeeds; PENDING/FAILED remain retryable.
 */

export const STRIPE_WEBHOOK_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
});

/**
 * @param {{ status?: string|null }} row
 * @returns {boolean}
 */
export function isStripeWebhookProcessed(row) {
  return String(row?.status || '').toUpperCase() === STRIPE_WEBHOOK_STATUS.PROCESSED;
}

/**
 * Claim exclusive processing rights for a Stripe event.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ eventId: string, type: string }} args
 * @returns {Promise<{ action: 'process'|'skip', reason?: string }>}
 */
export async function beginStripeWebhookEvent(prisma, { eventId, type }) {
  const id = String(eventId || '').trim();
  const eventType = String(type || '').trim() || 'unknown';
  if (!id) {
    return { action: 'skip', reason: 'missing_event_id' };
  }

  try {
    await prisma.stripeWebhookEvent.create({
      data: {
        eventId: id,
        type: eventType,
        status: STRIPE_WEBHOOK_STATUS.PENDING,
        processedAt: null,
      },
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'P2002') {
      const existing = await prisma.stripeWebhookEvent.findUnique({ where: { eventId: id } });
      if (!existing) {
        return { action: 'skip', reason: 'duplicate_missing_row' };
      }
      if (isStripeWebhookProcessed(existing)) {
        return { action: 'skip', reason: 'duplicate' };
      }
      if (String(existing.status).toUpperCase() === STRIPE_WEBHOOK_STATUS.PROCESSING) {
        return { action: 'skip', reason: 'in_progress' };
      }
      const claimed = await prisma.stripeWebhookEvent.updateMany({
        where: {
          eventId: id,
          status: { in: [STRIPE_WEBHOOK_STATUS.PENDING, STRIPE_WEBHOOK_STATUS.FAILED] },
        },
        data: { status: STRIPE_WEBHOOK_STATUS.PROCESSING },
      });
      if (claimed.count === 1) {
        return { action: 'process' };
      }
      return { action: 'skip', reason: 'lost_claim' };
    }
    if (error && typeof error === 'object' && (error.code === 'P2021' || error.code === 'P2022')) {
      console.warn('[stripe webhook] idempotency table missing — run prisma migrate deploy');
      return { action: 'process', reason: 'table_missing_passthrough' };
    }
    throw error;
  }

  const claimed = await prisma.stripeWebhookEvent.updateMany({
    where: { eventId: id, status: STRIPE_WEBHOOK_STATUS.PENDING },
    data: { status: STRIPE_WEBHOOK_STATUS.PROCESSING },
  });
  if (claimed.count === 1) {
    return { action: 'process' };
  }
  return { action: 'skip', reason: 'lost_claim' };
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} eventId
 */
export async function completeStripeWebhookEvent(prisma, eventId) {
  const id = String(eventId || '').trim();
  if (!id) return;
  try {
    await prisma.stripeWebhookEvent.updateMany({
      where: { eventId: id },
      data: {
        status: STRIPE_WEBHOOK_STATUS.PROCESSED,
        processedAt: new Date(),
      },
    });
  } catch (error) {
    if (error && typeof error === 'object' && (error.code === 'P2021' || error.code === 'P2022')) {
      return;
    }
    throw error;
  }
}

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} eventId
 */
export async function failStripeWebhookEvent(prisma, eventId) {
  const id = String(eventId || '').trim();
  if (!id) return;
  try {
    await prisma.stripeWebhookEvent.updateMany({
      where: {
        eventId: id,
        status: STRIPE_WEBHOOK_STATUS.PROCESSING,
      },
      data: { status: STRIPE_WEBHOOK_STATUS.FAILED },
    });
  } catch (error) {
    if (error && typeof error === 'object' && (error.code === 'P2021' || error.code === 'P2022')) {
      return;
    }
    throw error;
  }
}
