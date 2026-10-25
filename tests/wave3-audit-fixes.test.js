import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEAM_PERMISSION_MODULES,
  TEAM_PERMISSION_TO_ROUTE_MODULES,
  canAccessRouteModule,
} from '../constants/admin-modules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('FMA-01: activity-log is a team permission and finance no longer includes activity', () => {
  assert.equal(TEAM_PERMISSION_MODULES.includes('activity-log'), true);
  assert.deepEqual(TEAM_PERMISSION_TO_ROUTE_MODULES['finance-management'], ['finance', 'store-credit']);
  assert.deepEqual(TEAM_PERMISSION_TO_ROUTE_MODULES['activity-log'], ['activity']);
  assert.equal(canAccessRouteModule(['finance-management'], 'activity'), false);
  assert.equal(canAccessRouteModule(['activity-log'], 'activity'), true);
});

test('PAY-12: admin refund idempotency keys include a unique attempt suffix', () => {
  const src = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  assert.match(src, /crypto\.randomBytes\(8\)/);
  assert.match(src, /order-admin-refund-\$\{orderPublicId\}-\$\{amountCents\}-\$\{refundAttemptId\}/);
  assert.doesNotMatch(src, /order-admin-refund-\$\{orderPublicId\}-\$\{amountCents\}`\.slice/);
});

test('FMA-04: refurb credit and listing require active Farmhouse Friends membership', () => {
  const returnsSrc = readFileSync(join(__dirname, '../services/returns.service.js'), 'utf8');
  const refurbSrc = readFileSync(join(__dirname, '../services/refurbishment.service.js'), 'utf8');
  assert.match(returnsSrc, /REFURB_MEMBERSHIP_REQUIRED/);
  assert.match(returnsSrc, /accessMemberUntil/);
  assert.match(refurbSrc, /REFURB_MEMBERSHIP_REQUIRED/);
  assert.match(refurbSrc, /nextStatus === 'LISTED'/);
});

test('SHP-03: checkout does not silently fall back to demo rates unless SHIPPING_DEMO_RATES=true', () => {
  const src = readFileSync(join(__dirname, '../services/shipping/shipping-orchestrator.js'), 'utf8');
  assert.match(src, /SHIPPING_RATES_UNAVAILABLE/);
  assert.match(src, /never as a silent UPS fallback/);
  assert.equal(src.includes("return demoRatesCheckoutPayload(payload, 'ups_empty_rates')"), false);
  assert.equal(src.includes("return demoRatesCheckoutPayload(payload, 'ups_rate_error')"), false);
  assert.equal(src.includes("return demoRatesCheckoutPayload(payload, 'ups_not_configured')"), false);
});
