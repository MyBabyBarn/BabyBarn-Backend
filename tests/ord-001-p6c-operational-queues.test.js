import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAdminStatusGroupWhere,
  buildDeliveredWhere,
  buildInProcessWhere,
  buildNewOrderQueueWhere,
  buildPartiallyRefundedWhere,
  buildPaymentPendingWhere,
  buildPickupReadyWhere,
  buildReadyToShipWhere,
  buildRefundedWhere,
  buildShippedWhere,
  buildToFulfillWhere,
} from '../lib/order-query-filters.js';

describe('ORD-001 P6c — operational queue builders', () => {
  describe('Payment Pending', () => {
    it('UNPAID only', () => {
      assert.deepEqual(buildPaymentPendingWhere(), { paymentStatus: 'UNPAID' });
      assert.deepEqual(buildAdminStatusGroupWhere('payment_pending'), buildPaymentPendingWhere());
    });

    it('FAILED is not Payment Pending', () => {
      assert.notEqual(buildPaymentPendingWhere().paymentStatus, 'FAILED');
      assert.ok(!JSON.stringify(buildPaymentPendingWhere()).includes('FAILED'));
    });
  });

  describe('To Fulfill / New / In process', () => {
    it('PAID + NEW_ORDER|ACCEPTED shape', () => {
      const w = buildToFulfillWhere();
      assert.deepEqual(w.fulfillmentStatus.in, ['NEW_ORDER', 'ACCEPTED']);
      assert.deepEqual(w.paymentStatus.in, ['PAID', 'PARTIALLY_REFUNDED']);
      assert.deepEqual(w.status.notIn, ['CANCELLED', 'REFUNDED']);
    });

    it('statusGroup to_fulfill / legacy pending alias → To Fulfill', () => {
      assert.deepEqual(buildAdminStatusGroupWhere('to_fulfill'), buildToFulfillWhere());
      assert.deepEqual(buildAdminStatusGroupWhere('pending'), buildToFulfillWhere());
    });

    it('New = intake with zero picks; In process = some picks', () => {
      assert.deepEqual(buildAdminStatusGroupWhere('new'), buildNewOrderQueueWhere());
      assert.deepEqual(buildAdminStatusGroupWhere('in_process'), buildInProcessWhere());
      assert.deepEqual(buildNewOrderQueueWhere().AND[1], {
        orderItems: { every: { pickedQuantity: 0 } },
      });
      assert.deepEqual(buildInProcessWhere().AND[1], {
        orderItems: { some: { pickedQuantity: { gt: 0 } } },
      });
    });
  });

  describe('Pickup Ready / Ready to ship', () => {
    it('includes LABEL_GENERATED + PARTIALLY_REFUNDED; no tracking predicate', () => {
      const w = buildPickupReadyWhere();
      assert.deepEqual(w.fulfillmentStatus.in, ['PICKUP_READY', 'LABEL_GENERATED']);
      assert.deepEqual(w.paymentStatus.in, ['PAID', 'PARTIALLY_REFUNDED']);
      assert.equal(w.trackingNumber, undefined);
      assert.deepEqual(buildReadyToShipWhere(), w);
      assert.deepEqual(buildAdminStatusGroupWhere('ready_to_ship'), w);
    });

    it('PICKUP_READY not in Shipped', () => {
      assert.ok(!buildShippedWhere().fulfillmentStatus.in.includes('PICKUP_READY'));
    });
  });

  describe('Shipped', () => {
    it('SHIPPED / IN_TRANSIT / OUT_FOR_DELIVERY', () => {
      assert.deepEqual(buildShippedWhere().fulfillmentStatus.in, [
        'SHIPPED',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
      ]);
    });
  });

  describe('Delivered / Refund / Partial', () => {
    it('Delivered OR triad', () => {
      assert.deepEqual(buildDeliveredWhere(), {
        OR: [
          { fulfillmentStatus: 'DELIVERED' },
          { deliveredAt: { not: null } },
          { status: 'DELIVERED' },
        ],
      });
    });

    it('Refunded vs Partially Refunded separate', () => {
      assert.deepEqual(buildRefundedWhere(), { paymentStatus: 'REFUNDED' });
      assert.deepEqual(buildPartiallyRefundedWhere(), { paymentStatus: 'PARTIALLY_REFUNDED' });
      assert.deepEqual(buildAdminStatusGroupWhere('refunded'), buildRefundedWhere());
      assert.deepEqual(
        buildAdminStatusGroupWhere('partially_refunded'),
        buildPartiallyRefundedWhere()
      );
    });
  });

  describe('Partial cancel scenario (predicate coexistence)', () => {
    it('PARTIALLY_REFUNDED + ACCEPTED matches To Fulfill and Partially Refunded builders', () => {
      const toFulfill = buildToFulfillWhere();
      const partial = buildPartiallyRefundedWhere();
      assert.ok(toFulfill.paymentStatus.in.includes('PARTIALLY_REFUNDED'));
      assert.ok(toFulfill.fulfillmentStatus.in.includes('ACCEPTED'));
      assert.equal(partial.paymentStatus, 'PARTIALLY_REFUNDED');
      assert.notEqual(toFulfill.status?.notIn?.includes('CANCELLED'), false);
      // Cancelled queue is status=CANCELLED only — partial cancel stays out
      assert.deepEqual(buildAdminStatusGroupWhere('cancelled'), { status: 'CANCELLED' });
    });
  });

  describe('list/count identity', () => {
    for (const key of [
      'payment_pending',
      'to_fulfill',
      'new',
      'in_process',
      'pickup_ready',
      'ready_to_ship',
      'shipped',
      'delivered',
      'cancelled',
      'returned',
      'refunded',
      'partially_refunded',
    ]) {
      it(`${key}: statusGroup builder is stable`, () => {
        const a = buildAdminStatusGroupWhere(key);
        const b = buildAdminStatusGroupWhere(key);
        assert.deepEqual(a, b);
        assert.ok(a);
      });
    }
  });
});

/**
 * In-memory membership checks mirroring builders (for matrix clarity).
 */
function inPaymentPending(o) {
  return o.paymentStatus === 'UNPAID';
}
function inToFulfill(o) {
  return (
    ['NEW_ORDER', 'ACCEPTED'].includes(o.fulfillmentStatus) &&
    ['PAID', 'PARTIALLY_REFUNDED'].includes(o.paymentStatus) &&
    !['CANCELLED', 'REFUNDED'].includes(o.status)
  );
}
function inPickupReady(o) {
  return (
    ['PICKUP_READY', 'LABEL_GENERATED'].includes(o.fulfillmentStatus) &&
    ['PAID', 'PARTIALLY_REFUNDED'].includes(o.paymentStatus) &&
    !['CANCELLED', 'REFUNDED'].includes(o.status)
  );
}
function inShipped(o) {
  return ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(o.fulfillmentStatus);
}
function inCancelled(o) {
  return o.status === 'CANCELLED';
}
function inRefunded(o) {
  return o.paymentStatus === 'REFUNDED';
}
function inPartiallyRefunded(o) {
  return o.paymentStatus === 'PARTIALLY_REFUNDED';
}

describe('ORD-001 P6c — scenario matrix', () => {
  it('UNPAID → Payment Pending only', () => {
    const o = { paymentStatus: 'UNPAID', status: 'PENDING', fulfillmentStatus: null };
    assert.equal(inPaymentPending(o), true);
    assert.equal(inToFulfill(o), false);
  });

  it('FAILED + CANCELLED → not Payment Pending', () => {
    assert.equal(
      inPaymentPending({ paymentStatus: 'FAILED', status: 'CANCELLED' }),
      false
    );
  });

  it('PAID + ACCEPTED → To Fulfill', () => {
    const o = { paymentStatus: 'PAID', fulfillmentStatus: 'ACCEPTED', status: 'PROCESSING' };
    assert.equal(inToFulfill(o), true);
    assert.equal(inPaymentPending(o), false);
  });

  it('PARTIALLY_REFUNDED + ACCEPTED → To Fulfill + Partially Refunded', () => {
    const o = {
      paymentStatus: 'PARTIALLY_REFUNDED',
      fulfillmentStatus: 'ACCEPTED',
      status: 'PROCESSING',
    };
    assert.equal(inToFulfill(o), true);
    assert.equal(inPartiallyRefunded(o), true);
    assert.equal(inCancelled(o), false);
    assert.equal(inRefunded(o), false);
  });

  it('REFUNDED / CANCELLED + ACCEPTED → not To Fulfill', () => {
    assert.equal(
      inToFulfill({
        paymentStatus: 'REFUNDED',
        fulfillmentStatus: 'ACCEPTED',
        status: 'REFUNDED',
      }),
      false
    );
    assert.equal(
      inToFulfill({
        paymentStatus: 'PAID',
        fulfillmentStatus: 'ACCEPTED',
        status: 'CANCELLED',
      }),
      false
    );
  });

  it('PICKUP_READY + tracking → Pickup Ready, not Shipped', () => {
    const o = {
      paymentStatus: 'PAID',
      fulfillmentStatus: 'PICKUP_READY',
      status: 'PROCESSING',
      trackingNumber: '1Z999',
    };
    assert.equal(inPickupReady(o), true);
    assert.equal(inShipped(o), false);
  });

  it('PARTIALLY_REFUNDED + PICKUP_READY → Pickup Ready', () => {
    assert.equal(
      inPickupReady({
        paymentStatus: 'PARTIALLY_REFUNDED',
        fulfillmentStatus: 'PICKUP_READY',
        status: 'PROCESSING',
      }),
      true
    );
  });

  it('carrier states → Shipped', () => {
    for (const fs of ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']) {
      assert.equal(inShipped({ fulfillmentStatus: fs }), true);
    }
  });

  it('Delivered triad', () => {
    const matchesDelivered = (o) =>
      o.fulfillmentStatus === 'DELIVERED' ||
      o.deliveredAt != null ||
      o.status === 'DELIVERED';
    assert.equal(matchesDelivered({ fulfillmentStatus: 'DELIVERED' }), true);
    assert.equal(matchesDelivered({ deliveredAt: new Date(), status: 'PROCESSING' }), true);
    assert.equal(matchesDelivered({ status: 'DELIVERED', fulfillmentStatus: null }), true);
    assert.deepEqual(buildDeliveredWhere().OR.length, 3);
  });

  it('REFUNDED / PARTIALLY_REFUNDED financial queues', () => {
    assert.equal(inRefunded({ paymentStatus: 'REFUNDED' }), true);
    assert.equal(inPartiallyRefunded({ paymentStatus: 'PARTIALLY_REFUNDED' }), true);
  });

  it('partial cancel: Line A cancelled, Line B active → To Fulfill + Partially Refunded, not Cancelled', () => {
    const o = {
      paymentStatus: 'PARTIALLY_REFUNDED',
      fulfillmentStatus: 'ACCEPTED',
      status: 'PROCESSING',
      lines: [{ cancelledAt: new Date() }, { cancelledAt: null }],
    };
    assert.equal(inToFulfill(o), true);
    assert.equal(inCancelled(o), false);
    assert.equal(inPartiallyRefunded(o), true);
  });
});
