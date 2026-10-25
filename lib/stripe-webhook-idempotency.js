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

/** A dead worker must not hold a Stripe event forever (PAY-04). */
export const WEBHOOK_PROCESSING_LEASE_MS = 15 * 60 * 1000;

function isMissingIdempotencyTable(error) {
  return Boolean(error && typeof error === 'object' && (error.code === 'P2021' || error.code === 'P2022'));
}

function idempotencyTableMissingError() {
  const error = new Error('Stripe webhook idempotency table is missing. Run prisma migrate deploy.');
  error.code = 'WEBHOOK_IDEMPOTENCY_UNAVAILABLE';
  return error;
}

function claimIsFresh(claimedAt, now = Date.now()) {
  if (!claimedAt) return false;
  const started = new Date(claimedAt).getTime();
  if (!Number.isFinite(started)) return false;
  return now - started < WEBHOOK_PROCESSING_LEASE_MS;
}

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
        if (claimIsFresh(existing.claimedAt)) {
          return { action: 'skip', reason: 'in_progress' };
        }
        const reclaimed = await prisma.stripeWebhookEvent.updateMany({
          where: {
            eventId: id,
            status: STRIPE_WEBHOOK_STATUS.PROCESSING,
            claimedAt: existing.claimedAt ?? null,
          },
          data: {
            status: STRIPE_WEBHOOK_STATUS.PROCESSING,
            claimedAt: new Date(),
          },
        });
        if (reclaimed.count === 1) {
          return { action: 'process', reason: 'lease_expired' };
        }
        return { action: 'skip', reason: 'in_progress' };
      }
      const claimed = await prisma.stripeWebhookEvent.updateMany({
        where: {
          eventId: id,
          status: { in: [STRIPE_WEBHOOK_STATUS.PENDING, STRIPE_WEBHOOK_STATUS.FAILED] },
        },
        data: { status: STRIPE_WEBHOOK_STATUS.PROCESSING, claimedAt: new Date() },
      });
      if (claimed.count === 1) {
        return { action: 'process' };
      }
      return { action: 'skip', reason: 'lost_claim' };
    }
    if (isMissingIdempotencyTable(error)) {
      console.error('[stripe webhook] idempotency table missing — run prisma migrate deploy');
      throw idempotencyTableMissingError();
    }
    throw error;
  }

  const claimed = await prisma.stripeWebhookEvent.updateMany({
    where: { eventId: id, status: STRIPE_WEBHOOK_STATUS.PENDING },
    data: { status: STRIPE_WEBHOOK_STATUS.PROCESSING, claimedAt: new Date() },
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
 * Run a claimed webhook handler. Success marks PROCESSED. Any throw marks FAILED
 * so Stripe can retry (PAY-01).
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} eventId
 * @param {() => Promise<unknown>} handler
 */
export async function finishStripeWebhookEvent(prisma, eventId, handler) {
  try {
    const result = await handler();
    await completeStripeWebhookEvent(prisma, eventId);
    return result;
  } catch (err) {
    await failStripeWebhookEvent(prisma, eventId);
    throw err;
  }
}

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
