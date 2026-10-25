import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeCsvCell, rowsToCsv } from '../lib/csv-safe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('PAY-05 / PAY-13: Connect destination failures fail closed (no silent fallback)', () => {
  const src = readFileSync(join(__dirname, '../services/payment.service.js'), 'utf8');
  assert.match(src, /STRIPE_CONNECT_DESTINATION_INVALID/);
  assert.equal(src.includes('fallback without transfer_data'), false);
  assert.equal(src.includes('retrySession = await stripe.checkout.sessions.create(fallbackPayload)'), false);
  assert.equal(
    /connectDestinationProblem[\s\S]{0,400}paymentIntents\.create\(basePayload\)/.test(src),
    false
  );
});

test('SEC-10: CSV cells neutralize formula injection', () => {
  assert.equal(escapeCsvCell('+1234'), "'+1234");
  assert.equal(escapeCsvCell('-1+1'), "'-1+1");
  assert.equal(escapeCsvCell('@sum'), "'@sum");
  assert.equal(escapeCsvCell('normal'), 'normal');
  assert.match(escapeCsvCell('=HYPERLINK("http://x")'), /'=HYPERLINK/);
  const csv = rowsToCsv(['name'], [['=CMD()']]);
  assert.equal(csv, "name\r\n'=CMD()");
});

test('SEC-09: request logger redacts token query params', () => {
  const src = readFileSync(join(__dirname, '../index.js'), 'utf8');
  assert.match(src, /redactLoggedPath/);
  assert.match(src, /\[redacted\]/);
  const tokenSrc = readFileSync(join(__dirname, '../lib/order-tracking-token.js'), 'utf8');
  assert.match(tokenSrc, /ORDER_TRACKING_TTL_DAYS \|\| 14/);
  assert.match(tokenSrc, /ORDER_TRACKING_SECRET/);
});

test('SEC-19: membership numbers use crypto entropy and anonymous preview hides owner name', () => {
  const membershipSrc = readFileSync(join(__dirname, '../services/membership.service.js'), 'utf8');
  assert.match(membershipSrc, /crypto\.randomBytes\(5\)/);
  assert.equal(membershipSrc.includes('Math.random()'), false);
  const routeSrc = readFileSync(join(__dirname, '../routes/membership.js'), 'utf8');
  assert.match(routeSrc, /anonymous preview returns validity only/);
  assert.match(routeSrc, /valid:/);
});

test('UIC-09: membership registration error uses Farmhouse Friends wording', () => {
  const src = readFileSync(join(__dirname, '../services/payment.service.js'), 'utf8');
  assert.match(src, /Complete Farmhouse Friends registration/);
  assert.equal(src.includes('Complete ACCESS registration'), false);
});
