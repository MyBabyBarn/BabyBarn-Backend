import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRIPE_WEBHOOK_STATUS,
  beginStripeWebhookEvent,
  completeStripeWebhookEvent,
  failStripeWebhookEvent,
  isStripeWebhookProcessed,
} from '../lib/stripe-webhook-idempotency.js';

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
