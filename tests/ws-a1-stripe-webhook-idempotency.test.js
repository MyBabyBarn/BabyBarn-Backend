import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRIPE_WEBHOOK_STATUS,
  WEBHOOK_PROCESSING_LEASE_MS,
  beginStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
  finishStripeWebhookEvent,
  isStripeWebhookProcessed,
} from '../lib/stripe-webhook-idempotency.js';
import { recordOpenPaymentReconciliation } from '../lib/payment-reconciliation.js';

/**
 * In-memory StripeWebhookEvent store that mirrors Prisma create / updateMany / findUnique.
 */
function createMockPrisma(store = new Map()) {
  return {
    _store: store,
    stripeWebhookEvent: {
      async create({ data }) {
        if (store.has(data.eventId)) {
          const err = new Error('Unique constraint');
          err.code = 'P2002';
          throw err;
        }
        store.set(data.eventId, {
          eventId: data.eventId,
          type: data.type,
          status: data.status,
          processedAt: data.processedAt ?? null,
          claimedAt: data.claimedAt ?? null,
        });
        return store.get(data.eventId);
      },
      async findUnique({ where }) {
        return store.get(where.eventId) ?? null;
      },
      async updateMany({ where, data }) {
        const row = store.get(where.eventId);
        if (!row) return { count: 0 };
        if (where.status) {
          const allowed = where.status.in
            ? where.status.in.map((s) => String(s).toUpperCase())
            : [String(where.status).toUpperCase()];
          if (!allowed.includes(String(row.status).toUpperCase())) {
            return { count: 0 };
          }
        }
        if (Object.prototype.hasOwnProperty.call(where, 'claimedAt')) {
          const left = row.claimedAt ? new Date(row.claimedAt).toISOString() : null;
          const right = where.claimedAt ? new Date(where.claimedAt).toISOString() : null;
          if (left !== right) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
}

test('A1: first webhook claim succeeds (PENDING → PROCESSING)', async () => {
  const prisma = createMockPrisma();
  const claim = await beginStripeWebhookEvent(prisma, { eventId: 'evt_1', type: 'checkout.session.completed' });
  assert.equal(claim.action, 'process');
  assert.equal(prisma._store.get('evt_1').status, STRIPE_WEBHOOK_STATUS.PROCESSING);
});

test('A1: duplicate PROCESSED webhook is a no-op skip', async () => {
  const prisma = createMockPrisma(
    new Map([
      [
        'evt_done',
        {
          eventId: 'evt_done',
          type: 'checkout.session.completed',
          status: STRIPE_WEBHOOK_STATUS.PROCESSED,
          processedAt: new Date(),
        },
      ],
    ])
  );
  const claim = await beginStripeWebhookEvent(prisma, {
    eventId: 'evt_done',
    type: 'checkout.session.completed',
  });
  assert.equal(claim.action, 'skip');
  assert.equal(claim.reason, 'duplicate');
});

test('A1: failed attempt leaves event retryable (FAILED)', async () => {
  const prisma = createMockPrisma();
  await beginStripeWebhookEvent(prisma, { eventId: 'evt_fail', type: 'payment_intent.succeeded' });
  await failStripeWebhookEvent(prisma, 'evt_fail');
  assert.equal(prisma._store.get('evt_fail').status, STRIPE_WEBHOOK_STATUS.FAILED);
  assert.equal(isStripeWebhookProcessed(prisma._store.get('evt_fail')), false);
});

test('A1: retry after failure reclaims and can complete', async () => {
  const prisma = createMockPrisma(
    new Map([
      [
        'evt_retry',
        {
          eventId: 'evt_retry',
          type: 'checkout.session.completed',
          status: STRIPE_WEBHOOK_STATUS.FAILED,
          processedAt: null,
        },
      ],
    ])
  );
  const claim = await beginStripeWebhookEvent(prisma, {
    eventId: 'evt_retry',
    type: 'checkout.session.completed',
  });
  assert.equal(claim.action, 'process');
  await completeStripeWebhookEvent(prisma, 'evt_retry');
  assert.equal(prisma._store.get('evt_retry').status, STRIPE_WEBHOOK_STATUS.PROCESSED);
  assert.ok(prisma._store.get('evt_retry').processedAt);
});

test('A1: concurrent duplicate delivery — only one worker processes', async () => {
  const prisma = createMockPrisma();
  const [a, b] = await Promise.all([
    beginStripeWebhookEvent(prisma, { eventId: 'evt_race', type: 'charge.refunded' }),
    beginStripeWebhookEvent(prisma, { eventId: 'evt_race', type: 'charge.refunded' }),
  ]);
  const actions = [a.action, b.action].sort();
  assert.deepEqual(actions, ['process', 'skip']);
  assert.equal(prisma._store.get('evt_race').status, STRIPE_WEBHOOK_STATUS.PROCESSING);
});

test('A1: successful handler marks PROCESSED; only then is permanent', async () => {
  const prisma = createMockPrisma();
  await beginStripeWebhookEvent(prisma, { eventId: 'evt_ok', type: 'checkout.session.completed' });
  assert.equal(isStripeWebhookProcessed(prisma._store.get('evt_ok')), false);
  await completeStripeWebhookEvent(prisma, 'evt_ok');
  assert.equal(isStripeWebhookProcessed(prisma._store.get('evt_ok')), true);

  const again = await beginStripeWebhookEvent(prisma, {
    eventId: 'evt_ok',
    type: 'checkout.session.completed',
  });
  assert.equal(again.action, 'skip');
});

test('PAY-04: a fresh PROCESSING claim is left in progress', async () => {
  const prisma = createMockPrisma(
    new Map([
      [
        'evt_live',
        {
          eventId: 'evt_live',
          type: 'payment_intent.succeeded',
          status: STRIPE_WEBHOOK_STATUS.PROCESSING,
          processedAt: null,
          claimedAt: new Date(),
        },
      ],
    ])
  );
  const claim = await beginStripeWebhookEvent(prisma, {
    eventId: 'evt_live',
    type: 'payment_intent.succeeded',
  });
  assert.equal(claim.action, 'skip');
  assert.equal(claim.reason, 'in_progress');
});

test('PAY-04: a PROCESSING claim older than the lease is reclaimed', async () => {
  const prisma = createMockPrisma(
    new Map([
      [
        'evt_stale',
        {
          eventId: 'evt_stale',
          type: 'payment_intent.succeeded',
          status: STRIPE_WEBHOOK_STATUS.PROCESSING,
          processedAt: null,
          claimedAt: new Date(Date.now() - WEBHOOK_PROCESSING_LEASE_MS - 1000),
        },
      ],
    ])
  );
  const claim = await beginStripeWebhookEvent(prisma, {
    eventId: 'evt_stale',
    type: 'payment_intent.succeeded',
  });
  assert.equal(claim.action, 'process');
  assert.equal(claim.reason, 'lease_expired');
  assert.equal(prisma._store.get('evt_stale').status, STRIPE_WEBHOOK_STATUS.PROCESSING);
});

test('PAY-04: a missing idempotency table fails closed', async () => {
  const prisma = {
    stripeWebhookEvent: {
      async create() {
        const error = new Error('table missing');
        error.code = 'P2021';
        throw error;
      },
    },
  };
  await assert.rejects(
    () => beginStripeWebhookEvent(prisma, { eventId: 'evt_missing', type: 'payment_intent.succeeded' }),
    (error) => error.code === 'WEBHOOK_IDEMPOTENCY_UNAVAILABLE'
  );
});

test('PAY-01: paid checkout failure records reconciliation and leaves the webhook FAILED', async () => {
  const reconciliations = [];
  const prisma = createMockPrisma();
  let nextId = 1;
  prisma.paymentReconciliation = {
    async findFirst({ where }) {
      return (
        reconciliations.find(
          (row) =>
            row.checkoutIntentPublicId === where.checkoutIntentPublicId && row.status === where.status
        ) || null
      );
    },
    async create({ data }) {
      const row = { id: nextId, ...data };
      nextId += 1;
      reconciliations.push(row);
      return row;
    },
    async update({ where, data }) {
      const row = reconciliations.find((item) => item.id === where.id);
      Object.assign(row, data);
      return row;
    },
  };

  await beginStripeWebhookEvent(prisma, { eventId: 'evt_paid', type: 'payment_intent.succeeded' });
  await assert.rejects(
    () =>
      finishStripeWebhookEvent(prisma, 'evt_paid', async () => {
        await recordOpenPaymentReconciliation(prisma, {
          checkoutIntentPublicId: 'ci_paid',
          paymentIntentId: 'pi_paid',
          amountCents: 6620,
          error: 'order create failed',
        });
        throw new Error('order create failed');
      }),
    /order create failed/
  );

  assert.equal(prisma._store.get('evt_paid').status, STRIPE_WEBHOOK_STATUS.FAILED);
  assert.equal(reconciliations.length, 1);
  assert.equal(reconciliations[0].status, 'OPEN');
  assert.equal(reconciliations[0].checkoutIntentPublicId, 'ci_paid');
  assert.equal(reconciliations[0].amountCents, 6620);
});
