import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashAuthToken } from '../lib/auth-token-hash.js';
import {
  assertLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
  _resetLoginLockoutForTests,
} from '../lib/login-lockout.js';
import { clampLimit } from '../lib/pagination.js';
import { normalizeAdminListPagination } from '../lib/return-admin-list-query.js';
import { AppError } from '../utils/error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('SEC-07: auth tokens are hashed before storage', () => {
  const raw = 'abc123token';
  const hashed = hashAuthToken(raw);
  assert.equal(hashed.length, 64);
  assert.notEqual(hashed, raw);
  const authSrc = readFileSync(join(__dirname, '../services/auth.service.js'), 'utf8');
  assert.match(authSrc, /hashAuthToken\(raw\)/);
  assert.match(authSrc, /token: hashAuthToken\(raw\)/);
  assert.match(authSrc, /updateMany\(\{[\s\S]*usedAt: null/);
  const adminSrc = readFileSync(join(__dirname, '../services/admin.service.js'), 'utf8');
  assert.match(adminSrc, /token: hashAuthToken\(setPasswordToken\)/);
});

test('SEC-16: per-account login lockout trips after repeated failures', () => {
  _resetLoginLockoutForTests();
  const email = 'lockout@example.com';
  const ip = '203.0.113.9';
  for (let i = 0; i < 4; i += 1) {
    recordLoginFailure(email, ip);
    assert.doesNotThrow(() => assertLoginAllowed(email, ip));
  }
  const fifth = recordLoginFailure(email, ip);
  assert.equal(fifth.locked, true);
  assert.throws(() => assertLoginAllowed(email, ip), (err) => err instanceof AppError && err.code === 'LOGIN_LOCKED');
  clearLoginFailures(email, ip);
  assert.doesNotThrow(() => assertLoginAllowed(email, ip));
});

test('SEC-08: guest cancel requires a tracking token', () => {
  const src = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  assert.match(src, /TRACKING_TOKEN_REQUIRED/);
  assert.match(src, /guest cancel requires the signed tracking token/);
});

test('SCL-04: list limits are hard-capped', () => {
  assert.equal(clampLimit(9999), 100);
  assert.equal(clampLimit('0'), 1);
  assert.equal(clampLimit(undefined), 20);
  assert.equal(normalizeAdminListPagination({ limit: 0 }).limit, 200);
  assert.equal(normalizeAdminListPagination({ limit: 500 }).limit, 100);
  const returnsSrc = readFileSync(join(__dirname, '../services/returns.service.js'), 'utf8');
  assert.match(returnsSrc, /take: limit/);
});
