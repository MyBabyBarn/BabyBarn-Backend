import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPLETED_RETURN_MATCH,
  CUSTOMER_ACTIVE_EXCLUDED_STATUSES,
  LEGACY_ADMIN_STATUS_GROUPS,
  LEGACY_CUSTOMER_TERMINAL_STATUSES,
  buildAdminStatusGroupWhere,
  buildCancelledWhere,
  buildCustomerActiveWhere,
  buildCustomerDeliveredWhere,
  buildCustomerHasAnyReturnWhere,
  buildCustomerInTransitWhere,
  buildDeliveredWhere,
  buildLegacyAdminPendingCountWhere,
  buildLegacyAdminStatusGroupWhere,
  buildPartiallyRefundedWhere,
  buildPaymentPendingWhere,
  buildPickupReadyWhere,
  buildRefundedWhere,
  buildReturnedWhere,
  buildShippedWhere,
  buildToFulfillWhere,
} from '../lib/order-query-filters.js';
import { OrderService } from '../services/order.service.js';

const orderService = new OrderService();

describe('ORD-001 P6a/P6c — target query builders', () => {
  it('Payment Pending is UNPAID only (not FAILED)', () => {
    assert.deepEqual(buildPaymentPendingWhere(), { paymentStatus: 'UNPAID' });
  });

  it('To Fulfill allows PAID|PARTIALLY_REFUNDED + NEW_ORDER|ACCEPTED, excludes terminal status', () => {
    assert.deepEqual(buildToFulfillWhere(), {
      fulfillmentStatus: { in: ['NEW_ORDER', 'ACCEPTED'] },
      paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    });
  });

  it('Pickup Ready / Ready to ship allows PAID|PARTIALLY_REFUNDED + PICKUP_READY|LABEL_GENERATED', () => {
    assert.deepEqual(buildPickupReadyWhere(), {
      fulfillmentStatus: { in: ['PICKUP_READY', 'LABEL_GENERATED'] },
      paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
      status: { notIn: ['CANCELLED', 'REFUNDED'] },
    });
  });

  it('Shipped is fulfillment SHIPPED|IN_TRANSIT|OUT_FOR_DELIVERY only', () => {
    const w = buildShippedWhere();
    assert.deepEqual(w.fulfillmentStatus.in, ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']);
    assert.equal(w.trackingNumber, undefined);
    assert.equal(w.status, undefined);
    assert.ok(!JSON.stringify(w).includes('PICKUP_READY'));
  });

  it('Delivered ORs fulfillment, deliveredAt, historical status', () => {
    const w = buildDeliveredWhere();
    assert.ok(w.OR.some((c) => c.fulfillmentStatus === 'DELIVERED'));
    assert.ok(w.OR.some((c) => c.deliveredAt?.not === null));
    assert.ok(w.OR.some((c) => c.status === 'DELIVERED'));
  });

  it('Cancelled is full Order.status CANCELLED', () => {
    assert.deepEqual(buildCancelledWhere(), { status: 'CANCELLED' });
  });

  it('Refunded / Partially refunded stay separate paymentStatus filters', () => {
    assert.deepEqual(buildRefundedWhere(), { paymentStatus: 'REFUNDED' });
    assert.deepEqual(buildPartiallyRefundedWhere(), { paymentStatus: 'PARTIALLY_REFUNDED' });
    assert.notDeepEqual(buildRefundedWhere(), buildPartiallyRefundedWhere());
  });

  it('Returned uses completed ReturnRequest statuses + historical Order.status RETURNED', () => {
    assert.equal(COMPLETED_RETURN_MATCH.STANDARD, 'APPROVED');
    assert.equal(COMPLETED_RETURN_MATCH.REFURBISHMENT, 'INSPECTION_APPROVED');

    const w = buildReturnedWhere();
    assert.ok(w.OR.some((c) => c.status === 'RETURNED'));
    const returnSome = w.OR.find((c) => c.returnRequests?.some);
    assert.ok(returnSome);
    const inner = returnSome.returnRequests.some.OR;
    assert.ok(inner.some((c) => c.type === 'STANDARD' && c.status === 'APPROVED'));
    assert.ok(inner.some((c) => c.type === 'REFURBISHMENT' && c.status === 'INSPECTION_APPROVED'));
    const blob = JSON.stringify(w);
    assert.ok(!blob.includes('REQUESTED'));
    assert.ok(!blob.includes('REJECTED'));
    assert.ok(!blob.includes('"UNDER_INSPECTION"'));
    assert.ok(!inner.some((c) => c.type === 'REFURBISHMENT' && c.status === 'APPROVED'));
  });
});

describe('ORD-001 P6c — Admin statusGroup → builders', () => {
  it('maps operational tabs to target builders', () => {
    assert.deepEqual(buildAdminStatusGroupWhere('payment_pending'), buildPaymentPendingWhere());
    assert.deepEqual(buildAdminStatusGroupWhere('to_fulfill'), buildToFulfillWhere());
    assert.deepEqual(buildAdminStatusGroupWhere('pending'), buildToFulfillWhere());
    assert.deepEqual(buildAdminStatusGroupWhere('pickup_ready'), buildPickupReadyWhere());
    assert.deepEqual(buildAdminStatusGroupWhere('shipped'), buildShippedWhere());
    assert.deepEqual(buildAdminStatusGroupWhere('delivered'), buildDeliveredWhere());
    assert.deepEqual(buildAdminStatusGroupWhere('cancelled'), buildCancelledWhere());
    assert.deepEqual(buildAdminStatusGroupWhere('returned'), buildReturnedWhere());
    assert.deepEqual(buildAdminStatusGroupWhere('refunded'), buildRefundedWhere());
    assert.deepEqual(
      buildAdminStatusGroupWhere('partially_refunded'),
      buildPartiallyRefundedWhere()
    );
  });

  it('legacy alias buildLegacyAdminStatusGroupWhere delegates to Admin builder', () => {
    assert.deepEqual(
      buildLegacyAdminStatusGroupWhere('returned'),
      buildAdminStatusGroupWhere('returned')
    );
  });
});

describe('ORD-001 P6a — legacy dashboard pending count preserved', () => {
  it('legacy pending group matches pre-P6 STATUS_GROUPS.pending', () => {
    assert.deepEqual([...LEGACY_ADMIN_STATUS_GROUPS.pending], [
      'PENDING',
      'PROCESSING',
      'CONFIRMED',
    ]);
    assert.deepEqual(buildLegacyAdminPendingCountWhere(), {
      status: { in: ['PENDING', 'PROCESSING', 'CONFIRMED'] },
    });
  });

  it('customer delivered/active/returns builders (P6d Active uses triad NOT)', () => {
    assert.deepEqual(buildCustomerDeliveredWhere(), {
      OR: [
        { status: 'DELIVERED' },
        { fulfillmentStatus: 'DELIVERED' },
        { deliveredAt: { not: null } },
      ],
    });
    assert.deepEqual(buildCustomerActiveWhere(), {
      AND: [
        { NOT: buildCustomerDeliveredWhere() },
        { status: { notIn: [...CUSTOMER_ACTIVE_EXCLUDED_STATUSES] } },
      ],
    });
    assert.deepEqual(buildCustomerHasAnyReturnWhere(), {
      returnRequests: { some: {} },
    });
    assert.ok(buildCustomerInTransitWhere().AND);
    assert.deepEqual([...LEGACY_CUSTOMER_TERMINAL_STATUSES], [
      'DELIVERED',
      'CANCELLED',
      'REFUNDED',
      'RETURNED',
    ]);
  });

  it('buildUserOrderListWhere still embeds the same customer tab builders', () => {
    const delivered = orderService.buildUserOrderListWhere(1, { tab: 'delivered' });
    assert.deepEqual(
      delivered.AND.find((c) => c.OR),
      buildCustomerDeliveredWhere()
    );

    const active = orderService.buildUserOrderListWhere(1, { tab: 'active' });
    assert.deepEqual(
      active.AND.find((c) => c.AND),
      buildCustomerActiveWhere()
    );

    const returns = orderService.buildUserOrderListWhere(1, { tab: 'returns' });
    assert.ok(returns.AND.some((c) => c.returnRequests?.some));
  });
});

describe('ORD-001 P6a — critical invariants encoded in target builders', () => {
  it('PICKUP_READY + tracking is not selected by buildShippedWhere shape', () => {
    const shipped = buildShippedWhere();
    const pickup = buildPickupReadyWhere();
    assert.notDeepEqual(shipped.fulfillmentStatus, pickup.fulfillmentStatus);
    assert.deepEqual(pickup.fulfillmentStatus.in, ['PICKUP_READY', 'LABEL_GENERATED']);
    assert.ok(!shipped.fulfillmentStatus.in.includes('PICKUP_READY'));
    assert.ok(!shipped.fulfillmentStatus.in.includes('ACCEPTED'));
    assert.ok(!shipped.fulfillmentStatus.in.includes('LABEL_GENERATED'));
  });

  it('target Returned ≠ customer any-return tab', () => {
    assert.notDeepEqual(buildReturnedWhere(), buildCustomerHasAnyReturnWhere());
  });

  it('target Delivered is compatible with customer delivered OR (same three arms)', () => {
    const target = buildDeliveredWhere()
      .OR.map((x) => JSON.stringify(x))
      .sort();
    const customer = buildCustomerDeliveredWhere()
      .OR.map((x) => JSON.stringify(x))
      .sort();
    assert.deepEqual(target, customer);
  });
});
