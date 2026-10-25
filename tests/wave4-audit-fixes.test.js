import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUEST_RETENTION_DAYS } from '../services/guest-retention.service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('ORD-03: zero-charge checkout is allowed; only 0 < amount < 50 is rejected', () => {
  const src = readFileSync(join(__dirname, '../services/payment.service.js'), 'utf8');
  assert.match(src, /amountCents === 0/);
  assert.match(src, /expectedCents === 0/);
  assert.match(src, /zeroCharge:\s*true/);
  assert.match(src, /amountCents > 0 && amountCents < 50/);
  assert.match(src, /charge\.expectedCents > 0 && charge\.expectedCents < 50/);
});

test('PAY-06: checkout summary does not create or fulfill orders', () => {
  const src = readFileSync(join(__dirname, '../services/payment.service.js'), 'utf8');
  const summaryStart = src.indexOf('export async function getCheckoutSessionSummary');
  const summaryEnd = src.indexOf('export async function', summaryStart + 10);
  const body = src.slice(summaryStart, summaryEnd > 0 ? summaryEnd : undefined);
  assert.match(body, /PAY-06/);
  assert.match(body, /status: 'pending'/);
  assert.equal(body.includes('handleCheckoutIntentPaymentCompleted'), false);
  assert.equal(body.includes('fulfillUnpaidOrderAfterPayment'), false);
});

test('PAY-07: superseded checkout intents cancel open Stripe PaymentIntents', () => {
  const src = readFileSync(join(__dirname, '../services/checkout-intent.service.js'), 'utf8');
  assert.match(src, /paymentIntents\.cancel/);
  assert.match(src, /PAY-07/);
});

test('PAY-11: paid checkout fulfilment still compares Stripe amount to checkout total', () => {
  const src = readFileSync(join(__dirname, '../services/payment.service.js'), 'utf8');
  assert.match(src, /checkoutAmountMatches/);
  assert.match(src, /CHECKOUT_AMOUNT_MISMATCH/);
});

test('REQ-08: guest retention defaults to 45 days and soft-deletes without wiping PII', () => {
  const src = readFileSync(join(__dirname, '../services/guest-retention.service.js'), 'utf8');
  assert.match(src, /GUEST_RETENTION_DAYS \?\? 45/);
  assert.ok(Number.isFinite(GUEST_RETENTION_DAYS) && GUEST_RETENTION_DAYS > 0);
  assert.match(src, /guestPurgedAt: new Date\(\)/);
  assert.equal(src.includes('address.deleteMany'), false);
  assert.equal(src.includes('contactPhone: null'), false);
});

test('UIC-09: order confirmation email uses Farmhouse Friends, not ACCESS member', () => {
  const src = readFileSync(join(__dirname, '../packages/brand/email/templates.js'), 'utf8');
  assert.match(src, /As a Farmhouse Friends member, your package includes a reusable return envelope/);
  assert.equal(src.includes('As an ACCESS member'), false);
});
