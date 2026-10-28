import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('PAY-08: bundled membership checkout can assign membershipPaymentId after the order is saved', () => {
  const source = readFileSync(join(__dirname, '../services/checkout-intent.service.js'), 'utf8');
  const start = source.indexOf('async createPaidOrderFromCheckoutIntent');
  const end = source.indexOf('async expireStaleCheckoutIntents');
  const body = source.slice(start, end);

  assert.match(body, /let order = await db\(\)\.\$transaction/);
  assert.doesNotMatch(body, /const order = await db\(\)\.\$transaction/);
  assert.match(body, /membershipPaymentId:\s*membershipPayment\.id/);
  assert.match(body, /order = await db\(\)\.order\.update/);
});
