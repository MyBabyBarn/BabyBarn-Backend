import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postPaymentFulfillmentFields } from '../lib/order-fulfillment-start.js';
import {
  canCustomerCancelOrder,
  customerCancelUnavailableReason,
  customerCancelWindowStart,
} from '../lib/customer-order-cancellation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('ORD-001 P1: post-payment fulfillment is ACCEPTED with fulfillmentAcceptedAt', () => {
  const at = new Date('2026-08-10T12:00:00.000Z');
  assert.deepEqual(postPaymentFulfillmentFields(at), {
    fulfillmentStatus: 'ACCEPTED',
    fulfillmentAcceptedAt: at,
  });
});

test('ORD-001 P1: checkout-intent and legacy unpaid fulfill share canonical helper', () => {
  const checkout = readFileSync(join(__dirname, '../services/checkout-intent.service.js'), 'utf8');
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  assert.match(checkout, /postPaymentFulfillmentFields/);
  assert.match(orderSvc, /postPaymentFulfillmentFields/);
  assert.doesNotMatch(checkout, /fulfillmentStatus:\s*'NEW_ORDER'/);
  assert.match(orderSvc, /async fulfillUnpaidOrderAfterPayment/);
});

test('ORD-001 P1: payment service still routes intent → createPaidOrder and legacy → fulfillUnpaid', () => {
  const payment = readFileSync(join(__dirname, '../services/payment.service.js'), 'utf8');
  assert.match(payment, /createPaidOrderFromCheckoutIntent/);
  assert.match(payment, /fulfillUnpaidOrderAfterPayment/);
});

test('ORD-001 P1: cancel allowed for ACCEPTED within window (not blocked as warehouse started)', () => {
  const acceptedAt = new Date(Date.now() - 5 * 60 * 1000);
  const order = {
    status: 'PROCESSING',
    paymentStatus: 'PAID',
    fulfillmentStatus: 'ACCEPTED',
    fulfillmentAcceptedAt: acceptedAt,
    createdAt: acceptedAt,
  };
  assert.equal(canCustomerCancelOrder(order), true);
  assert.equal(customerCancelWindowStart(order)?.getTime(), acceptedAt.getTime());
});

test('ORD-001 P1: cancel still allowed for legacy NEW_ORDER within window (existing orders)', () => {
  const createdAt = new Date(Date.now() - 10 * 60 * 1000);
  assert.equal(
    canCustomerCancelOrder({
      status: 'PROCESSING',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'NEW_ORDER',
      createdAt,
    }),
    true
  );
});

test('ORD-001 P1: cancel blocked after PICKUP_READY even inside time window', () => {
  const acceptedAt = new Date();
  assert.equal(
    canCustomerCancelOrder({
      status: 'PROCESSING',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'PICKUP_READY',
      fulfillmentAcceptedAt: acceptedAt,
      createdAt: acceptedAt,
    }),
    false
  );
  assert.match(
    customerCancelUnavailableReason({
      status: 'PROCESSING',
      paymentStatus: 'PAID',
      fulfillmentStatus: 'PICKUP_READY',
      fulfillmentAcceptedAt: acceptedAt,
      createdAt: acceptedAt,
    }),
    /Warehouse processing/i
  );
});

test('ORD-001 P1: pick-wave eligibility still treats ACCEPTED and legacy NEW_ORDER as pre-pick', {
  skip: !existsSync(join(__dirname, '../../admin-fe')),
}, () => {
  const adminFe = readFileSync(
    join(__dirname, '../../admin-fe/lib/admin-order-fulfillment.ts'),
    'utf8'
  );
  assert.match(adminFe, /Auto-accepted \(ACCEPTED\) or legacy NEW_ORDER/);
  assert.match(adminFe, /action === 'pickup_ready'/);
});
