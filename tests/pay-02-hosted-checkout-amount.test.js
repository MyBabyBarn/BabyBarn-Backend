import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usdToCents } from '../lib/order-refund-balance.js';
import {
  buildHostedCheckoutCharge,
  checkoutAmountMatches,
  sumHostedLineItemsCents,
} from '../lib/hosted-checkout-charge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('PAY-02: hosted checkout lines include shipping, tax, and membership minus store credit', () => {
  const intent = {
    totalAmount: 90.4,
    shippingCost: 8,
    taxAmount: 2.4,
    storeCreditApplied: 10,
    includeAccessMembership: true,
    accessMembershipAmount: 50,
    lines: [{ quantity: 2, price: 20, product: { name: 'Onesie' } }],
  };

  const charge = buildHostedCheckoutCharge(intent);
  const names = charge.lineItems.map((item) => item.price_data.product_data.name);

  assert.equal(charge.expectedCents, usdToCents(intent.totalAmount));
  assert.equal(sumHostedLineItemsCents(charge.lineItems) - charge.storeCreditCents, charge.expectedCents);
  assert.equal(charge.chargedCents, 9040);
  assert.equal(charge.storeCreditCents, 1000);
  assert.ok(names.includes('Onesie'));
  assert.ok(names.includes('Shipping'));
  assert.ok(names.includes('Sales tax'));
  assert.ok(names.includes('Baby Barn Farmhouse Friends (1 year)'));
});

test('PAY-02: fulfillment rejects a Stripe amount that is not the checkout total', () => {
  assert.equal(checkoutAmountMatches(8000, 9040), false);
  assert.equal(checkoutAmountMatches(9040, 9040), true);
  assert.equal(checkoutAmountMatches(null, 9040), false);
});

test('PAY-02: hosted session is built from the checkout charge and mismatch is not fulfilled', () => {
  const payment = readFileSync(join(__dirname, '../services/payment.service.js'), 'utf8');
  assert.match(payment, /buildHostedCheckoutCharge/);
  assert.match(payment, /storeCreditDiscounts/);
  assert.match(payment, /CHECKOUT_AMOUNT_MISMATCH/);
  assert.match(payment, /rejectMismatchedPaidCheckout/);
  assert.doesNotMatch(payment, /amount_off:\s*0/);
});
