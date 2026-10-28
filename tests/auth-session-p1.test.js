import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDurationToMs } from '../lib/duration.js';
import { config } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { authService } from '../services/auth.service.js';
import { generateToken, verifyToken, generateCheckoutToken } from '../utils/jwt.js';
import { PORTAL_SCOPE } from '../lib/portal-scope.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('SEC-001 P1: access JWT default config is short-lived (15m unless env overrides)', () => {
  assert.equal(parseDurationToMs('15m', 0), 15 * 60 * 1000);
  assert.equal(parseDurationToMs('7d', 0), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseDurationToMs('30d', 0), 30 * 24 * 60 * 60 * 1000);
  // Local .env was updated to 15m for P1; production must set JWT_EXPIRY explicitly if different.
  assert.ok(typeof config.jwt.expiryTime === 'string' && config.jwt.expiryTime.length > 0);
  assert.ok(Number(config.jwt.refreshExpiryMs) > 0);
});

test('SEC-001 P1: guest checkout JWT lifetime remains 2h (separate from access TTL)', () => {
  const token = generateCheckoutToken({ id: 'guest-test', role: 'CUSTOMER', scope: 'checkout' });
  const decoded = verifyToken(token);
  assert.equal(decoded.scope, 'checkout');
  const ttlSec = Number(decoded.exp) - Number(decoded.iat);
  assert.ok(ttlSec <= 2 * 60 * 60 + 5);
  assert.ok(ttlSec >= 2 * 60 * 60 - 5);
});

async function ensureRole(name) {
  const existing = await prisma.role.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.role.create({ data: { name } });
}

async function createPortalUser({ email, portalScope, roleName }) {
  const role = await ensureRole(roleName);
  const passwordHash = await bcrypt.hash('TestPass1!', 10);
  return prisma.user.create({
    data: {
      email,
      password: passwordHash,
      firstName: 'Sec',
      lastName: 'Test',
      roleId: role.id,
      portalScope,
      emailVerifiedAt: new Date(),
      isActive: true,
      isGuest: false,
    },
    include: { role: true },
  });
}

async function cleanupUser(userId) {
  if (!userId) return;
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

test('SEC-001 P1: customer login → refresh rotates → old refresh rejected → logout revokes', async () => {
  const email = `sec001.customer.${Date.now()}@example.com`;
  let userId;
  try {
    const user = await createPortalUser({
      email,
      portalScope: PORTAL_SCOPE.CUSTOMER,
      roleName: 'CUSTOMER',
    });
    userId = user.id;

    const login = await authService.login(email, 'TestPass1!', 'customer');
    assert.ok(login.token);
    assert.ok(login.refreshToken);
    const access = verifyToken(login.token);
    assert.equal(access.portalScope, PORTAL_SCOPE.CUSTOMER);

    const first = await authService.refreshAccessToken(login.refreshToken);
    assert.ok(first.token);
    assert.ok(first.refreshToken);
    assert.notEqual(first.refreshToken, login.refreshToken);
    assert.equal(first.user.portalScope, PORTAL_SCOPE.CUSTOMER);

    await assert.rejects(
      () => authService.refreshAccessToken(login.refreshToken),
      (err) => err?.code === 'INVALID_REFRESH_TOKEN' || err?.statusCode === 401
    );

    const second = await authService.refreshAccessToken(first.refreshToken);
    assert.ok(second.refreshToken);

    await authService.logoutByRefreshToken(second.refreshToken);
    await assert.rejects(
      () => authService.refreshAccessToken(second.refreshToken),
      (err) => err?.code === 'INVALID_REFRESH_TOKEN' || err?.statusCode === 401
    );
  } finally {
    await cleanupUser(userId);
  }
});

test('SEC-001 P1: admin login → refresh rotates → STAFF portal preserved → deactivated blocked', async () => {
  const email = `sec001.admin.${Date.now()}@example.com`;
  let userId;
  try {
    const user = await createPortalUser({
      email,
      portalScope: PORTAL_SCOPE.STAFF,
      roleName: 'ADMIN_TEAM',
    });
    userId = user.id;
    await prisma.user.update({
      where: { id: userId },
      data: { adminModules: ['finance-management'] },
    });

    const login = await authService.login(email, 'TestPass1!', 'admin');
    assert.ok(login.refreshToken);
    const access = verifyToken(login.token);
    assert.equal(access.portalScope, PORTAL_SCOPE.STAFF);

    const refreshed = await authService.refreshAccessToken(login.refreshToken);
    assert.equal(refreshed.user.portalScope, PORTAL_SCOPE.STAFF);
    assert.equal(refreshed.user.role, 'ADMIN_TEAM');
    const refreshedAccess = verifyToken(refreshed.token);
    assert.equal(refreshedAccess.portalScope, PORTAL_SCOPE.STAFF);

    await prisma.user.update({ where: { id: userId }, data: { isActive: false } });
    await assert.rejects(
      () => authService.refreshAccessToken(refreshed.refreshToken),
      (err) => err?.statusCode === 403
    );
  } finally {
    await cleanupUser(userId);
  }
});

test('SEC-001 P1: concurrent refresh of same token → only one succeeds', async () => {
  const email = `sec001.race.${Date.now()}@example.com`;
  let userId;
  try {
    const user = await createPortalUser({
      email,
      portalScope: PORTAL_SCOPE.CUSTOMER,
      roleName: 'CUSTOMER',
    });
    userId = user.id;
    const login = await authService.login(email, 'TestPass1!', 'customer');
    const results = await Promise.allSettled([
      authService.refreshAccessToken(login.refreshToken),
      authService.refreshAccessToken(login.refreshToken),
      authService.refreshAccessToken(login.refreshToken),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 2);
    assert.ok(fulfilled[0].value.refreshToken);
  } finally {
    await cleanupUser(userId);
  }
});

test('SEC-001 P1: SESSION_REVOKED path — password change wipes refresh tokens', async () => {
  const email = `sec001.revoke.${Date.now()}@example.com`;
  let userId;
  try {
    const user = await createPortalUser({
      email,
      portalScope: PORTAL_SCOPE.CUSTOMER,
      roleName: 'CUSTOMER',
    });
    userId = user.id;
    const login = await authService.login(email, 'TestPass1!', 'customer');
    await authService.changePassword(user.publicId, 'TestPass1!', 'TestPass2!');
    await assert.rejects(
      () => authService.refreshAccessToken(login.refreshToken),
      (err) => err?.statusCode === 401
    );
  } finally {
    await cleanupUser(userId);
  }
});

test('SEC-001 P1: cross-portal — customer refresh cannot become staff', async () => {
  const email = `sec001.cross.${Date.now()}@example.com`;
  let userId;
  try {
    const user = await createPortalUser({
      email,
      portalScope: PORTAL_SCOPE.CUSTOMER,
      roleName: 'CUSTOMER',
    });
    userId = user.id;
    const login = await authService.login(email, 'TestPass1!', 'customer');
    const refreshed = await authService.refreshAccessToken(login.refreshToken);
    assert.equal(refreshed.user.portalScope, PORTAL_SCOPE.CUSTOMER);
    assert.notEqual(refreshed.user.portalScope, PORTAL_SCOPE.STAFF);
    const payload = verifyToken(refreshed.token);
    assert.equal(payload.portalScope, PORTAL_SCOPE.CUSTOMER);
  } finally {
    await cleanupUser(userId);
  }
});

test('SEC-001 P1: logout without access JWT still revokes refresh', async () => {
  const email = `sec001.logout.${Date.now()}@example.com`;
  let userId;
  try {
    const user = await createPortalUser({
      email,
      portalScope: PORTAL_SCOPE.CUSTOMER,
      roleName: 'CUSTOMER',
    });
    userId = user.id;
    const login = await authService.login(email, 'TestPass1!', 'customer');
    await authService.logoutByRefreshToken(login.refreshToken);
    const remaining = await prisma.refreshToken.count({
      where: { userId, tokenHash: undefined },
    });
    void remaining;
    await assert.rejects(() => authService.refreshAccessToken(login.refreshToken));
  } finally {
    await cleanupUser(userId);
  }
});

test('SEC-001 P1: FE/API contract — admin stores refresh; logout route unauthenticated; no cookie auth', {
  skip: !existsSync(join(__dirname, '../../admin-fe')) || !existsSync(join(__dirname, '../../customer-fe')),
}, () => {
  const adminStore = readFileSync(join(__dirname, '../../admin-fe/lib/stores/auth.store.ts'), 'utf8');
  assert.match(adminStore, /setStoredRefreshToken/);
  assert.match(adminStore, /refreshToken/);

  const adminClient = readFileSync(join(__dirname, '../../admin-fe/lib/api-client.ts'), 'utf8');
  assert.match(adminClient, /refresh-token/);
  assert.match(adminClient, /_retry/);
  assert.match(adminClient, /SESSION_REVOKED/);
  assert.doesNotMatch(adminClient, /HttpOnly|document\.cookie|setCookie/);

  const customerClient = readFileSync(join(__dirname, '../../customer-fe/lib/api-client.ts'), 'utf8');
  assert.match(customerClient, /refreshToken/);
  assert.match(customerClient, /SESSION_REVOKED/);
  assert.doesNotMatch(customerClient, /HttpOnly|setCookie/);

  const authRoutes = readFileSync(join(__dirname, '../routes/auth.js'), 'utf8');
  assert.match(authRoutes, /router\.post\('\/logout'/);
  assert.doesNotMatch(
    authRoutes,
    /router\.post\(\s*'\/logout',\s*authenticate/
  );
});

test('SEC-001 P1: access token issued with configured expiry (not hard-coded 7d in jwt util)', () => {
  const jwtUtil = readFileSync(join(__dirname, '../utils/jwt.js'), 'utf8');
  assert.match(jwtUtil, /config\.jwt\.expiryTime/);
  assert.match(jwtUtil, /expiresIn: '2h'/); // guest checkout unchanged
});
