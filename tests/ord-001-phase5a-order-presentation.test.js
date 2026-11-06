import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveOrderPaymentPresentation,
  deriveOrderPresentation,
} from '../lib/order-presentation.js';

describe('ORD-001 Phase 5A — deriveOrderPresentation', () => {
  it('does not mutate input', () => {
    const input = {
      status: 'PROCESSING',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'ACCEPTED',
    };
    const freeze = JSON.stringify(input);
    deriveOrderPresentation(input);
    assert.equal(JSON.stringify(input), freeze);
  });

  describe('basic lifecycle', () => {
    it('unpaid PENDING → Pending', () => {
      const p = deriveOrderPresentation({
        status: 'PENDING',
        paymentStatus: 'PENDING',
        fulfillmentStatus: null,
      });
      assert.equal(p.customerLabel, 'Pending');
      assert.equal(p.adminLabel, 'Payment pending');
      assert.equal(p.key, 'pending');
    });

    it('paid PROCESSING → Preparing to ship / Processing', () => {
      const p = deriveOrderPresentation({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        fulfillmentStatus: null,
      });
      assert.equal(p.customerLabel, 'Preparing to ship');
      assert.equal(p.adminLabel, 'Processing');
    });

    it('paid ACCEPTED → Preparing to ship / New', () => {
      const p = deriveOrderPresentation({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'ACCEPTED',
      });
      assert.equal(p.key, 'accepted');
      assert.equal(p.customerLabel, 'Preparing to ship');
      assert.equal(p.adminLabel, 'New');
    });

    it('paid PICKUP_READY → Preparing to ship / Ready to ship', () => {
      const p = deriveOrderPresentation({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'PICKUP_READY',
      });
      assert.equal(p.key, 'pickup_ready');
      assert.equal(p.customerLabel, 'Preparing to ship');
      assert.equal(p.adminLabel, 'Ready to ship');
    });

    it('shipped', () => {
      const p = deriveOrderPresentation({
        status: 'SHIPPED',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'SHIPPED',
        outboundShippedAt: '2026-08-01T00:00:00.000Z',
      });
      assert.equal(p.customerLabel, 'Shipped');
      assert.equal(p.adminLabel, 'Shipped');
      assert.equal(p.key, 'shipped');
    });

    it('in transit', () => {
      const p = deriveOrderPresentation({
        status: 'SHIPPED',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'IN_TRANSIT',
      });
      assert.equal(p.key, 'in_transit');
      assert.equal(p.customerLabel, 'In transit');
      assert.equal(p.adminLabel, 'In transit');
    });

    it('out for delivery', () => {
      const p = deriveOrderPresentation({
        status: 'SHIPPED',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'OUT_FOR_DELIVERY',
      });
      assert.equal(p.key, 'out_for_delivery');
      assert.equal(p.customerLabel, 'Out for delivery');
    });

    it('delivered', () => {
      const p = deriveOrderPresentation({
        status: 'DELIVERED',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'DELIVERED',
        deliveredAt: '2026-08-02T00:00:00.000Z',
      });
      assert.equal(p.key, 'delivered');
      assert.equal(p.customerLabel, 'Delivered');
    });
  });

  describe('label-before-shipment', () => {
    it('PAID + PICKUP_READY + tracking + label is NOT Shipped', () => {
      const p = deriveOrderPresentation({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'PICKUP_READY',
        trackingNumber: '1Z999',
        shippingLabelUrl: 'https://example.com/label.pdf',
      });
      assert.notEqual(p.customerLabel, 'Shipped');
      assert.notEqual(p.adminLabel, 'Shipped');
      assert.equal(p.customerLabel, 'Preparing to ship');
      assert.equal(p.adminLabel, 'Ready to ship');
      assert.equal(p.key, 'pickup_ready');
    });

    it('PAID + ACCEPTED + tracking is NOT Shipped', () => {
      const p = deriveOrderPresentation({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'ACCEPTED',
        trackingNumber: '1Z999',
        shippingLabelUrl: 'https://example.com/label.pdf',
      });
      assert.equal(p.customerLabel, 'Preparing to ship');
      assert.equal(p.adminLabel, 'New');
    });
  });

  describe('payment', () => {
    it('FAILED → Payment failed', () => {
      const p = deriveOrderPresentation({
        status: 'PENDING',
        paymentStatus: 'FAILED',
      });
      assert.equal(p.key, 'payment_failed');
      assert.equal(p.customerLabel, 'Payment failed');
      assert.equal(deriveOrderPaymentPresentation('FAILED')?.label, 'Payment failed');
    });

    it('delivered + PARTIALLY_REFUNDED keeps Delivered primary', () => {
      const p = deriveOrderPresentation({
        status: 'DELIVERED',
        paymentStatus: 'PARTIALLY_REFUNDED',
        fulfillmentStatus: 'DELIVERED',
        deliveredAt: '2026-08-02T00:00:00.000Z',
      });
      assert.equal(p.customerLabel, 'Delivered');
      assert.equal(p.payment?.label, 'Partially refunded');
    });

    it('REFUNDED non-cancelled → Refunded primary', () => {
      const p = deriveOrderPresentation({
        status: 'DELIVERED',
        paymentStatus: 'REFUNDED',
        fulfillmentStatus: 'DELIVERED',
        deliveredAt: '2026-08-02T00:00:00.000Z',
      });
      assert.equal(p.key, 'refunded');
      assert.equal(p.customerLabel, 'Refunded');
      assert.equal(p.payment, null);
    });

    it('PAID has no payment secondary', () => {
      assert.equal(deriveOrderPaymentPresentation('PAID'), null);
      const p = deriveOrderPresentation({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'ACCEPTED',
      });
      assert.equal(p.payment, null);
    });
  });

  describe('cancel', () => {
    it('cancelled + unpaid', () => {
      const p = deriveOrderPresentation({
        status: 'CANCELLED',
        paymentStatus: 'PENDING',
      });
      assert.equal(p.key, 'cancelled');
      assert.equal(p.customerLabel, 'Cancelled');
      assert.equal(p.payment, null);
    });

    it('cancelled + refunded → Cancelled primary, Refunded secondary', () => {
      const p = deriveOrderPresentation({
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
      });
      assert.equal(p.customerLabel, 'Cancelled');
      assert.equal(p.payment?.label, 'Refunded');
    });
  });

  describe('returns', () => {
    it('delivered + active return', () => {
      const p = deriveOrderPresentation({
        status: 'DELIVERED',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'DELIVERED',
        deliveredAt: '2026-08-02T00:00:00.000Z',
        hasActiveReturn: true,
      });
      assert.equal(p.customerLabel, 'Delivered');
      assert.equal(p.return?.label, 'Return in progress');
    });

    it('delivered + completed return secondary', () => {
      const p = deriveOrderPresentation({
        status: 'DELIVERED',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'DELIVERED',
        deliveredAt: '2026-08-02T00:00:00.000Z',
        hasCompletedReturn: true,
      });
      assert.equal(p.customerLabel, 'Delivered');
      assert.equal(p.return?.label, 'Return completed');
    });

    it('partial return', () => {
      const p = deriveOrderPresentation({
        status: 'DELIVERED',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'DELIVERED',
        deliveredAt: '2026-08-02T00:00:00.000Z',
        isPartiallyReturned: true,
      });
      assert.equal(p.customerLabel, 'Delivered');
      assert.equal(p.return?.label, 'Partial return');
    });

    it('fullReturnLabel becomes primary', () => {
      const p = deriveOrderPresentation({
        status: 'DELIVERED',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'DELIVERED',
        deliveredAt: '2026-08-02T00:00:00.000Z',
        fullReturnLabel: 'Return Requested',
      });
      assert.equal(p.customerLabel, 'Return Requested');
      assert.equal(p.return, null);
    });
  });

  describe('historical', () => {
    it('CONFIRMED → Processing', () => {
      const p = deriveOrderPresentation({
        status: 'CONFIRMED',
        paymentStatus: 'PAID',
      });
      assert.equal(p.customerLabel, 'Processing');
      assert.equal(p.adminLabel, 'Processing');
    });

    it('RETURNED → Returned', () => {
      const p = deriveOrderPresentation({ status: 'RETURNED', paymentStatus: 'PAID' });
      assert.equal(p.customerLabel, 'Returned');
    });

    it('SHIPPED + null fulfillment → Shipped', () => {
      const p = deriveOrderPresentation({
        status: 'SHIPPED',
        paymentStatus: 'PAID',
        fulfillmentStatus: null,
      });
      assert.equal(p.key, 'shipped');
      assert.equal(p.customerLabel, 'Shipped');
    });

    it('DELIVERED + null deliveredAt → Delivered', () => {
      const p = deriveOrderPresentation({
        status: 'DELIVERED',
        paymentStatus: 'PAID',
        fulfillmentStatus: null,
        deliveredAt: null,
      });
      assert.equal(p.key, 'delivered');
      assert.equal(p.customerLabel, 'Delivered');
    });

    it('paid + null fulfillment → Preparing to ship', () => {
      const p = deriveOrderPresentation({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        fulfillmentStatus: null,
      });
      assert.equal(p.customerLabel, 'Preparing to ship');
      assert.equal(p.adminLabel, 'Processing');
    });

    it('unpaid + null fulfillment → Pending', () => {
      const p = deriveOrderPresentation({
        status: 'PENDING',
        paymentStatus: 'PENDING',
        fulfillmentStatus: null,
      });
      assert.equal(p.customerLabel, 'Pending');
    });
  });

  describe('combinations', () => {
    it('cancelled + refunded', () => {
      const p = deriveOrderPresentation({
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
      });
      assert.equal(p.key, 'cancelled');
      assert.equal(p.payment?.key, 'refunded');
    });

    it('delivered + partially refunded', () => {
      const p = deriveOrderPresentation({
        status: 'DELIVERED',
        paymentStatus: 'PARTIALLY_REFUNDED',
        fulfillmentStatus: 'DELIVERED',
        deliveredAt: '2026-08-01',
      });
      assert.equal(p.key, 'delivered');
      assert.equal(p.payment?.key, 'partially_refunded');
    });

    it('shipped + return approved (active return secondary)', () => {
      const p = deriveOrderPresentation({
        status: 'SHIPPED',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'SHIPPED',
        hasActiveReturn: true,
      });
      assert.equal(p.key, 'shipped');
      assert.equal(p.return?.label, 'Return in progress');
    });

    it('partial cancellation + paid keeps preparing primary', () => {
      const p = deriveOrderPresentation({
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        fulfillmentStatus: 'ACCEPTED',
        isPartiallyCancelled: true,
      });
      assert.equal(p.customerLabel, 'Preparing to ship');
      assert.equal(p.adminLabel, 'New');
    });

    it('partial cancellation + partially refunded', () => {
      const p = deriveOrderPresentation({
        status: 'PROCESSING',
        paymentStatus: 'PARTIALLY_REFUNDED',
        fulfillmentStatus: 'ACCEPTED',
        isPartiallyCancelled: true,
      });
      assert.equal(p.customerLabel, 'Preparing to ship');
      assert.equal(p.adminLabel, 'New');
      assert.equal(p.payment?.label, 'Partially refunded');
    });
  });
});
