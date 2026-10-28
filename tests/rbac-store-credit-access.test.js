import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEAM_PERMISSION_TO_ROUTE_MODULES,
  canAccessRouteModule,
} from '../constants/admin-modules.js';
import { userCanSeeModule } from '../lib/admin-module-access.js';
import { requireConsoleModule, requireConsoleModuleAny } from '../middleware/admin-console.js';
import { AppError } from '../utils/error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function runMiddleware(mw, user) {
  return new Promise((resolve) => {
    mw({ user }, {}, (err) => resolve(err ?? null));
  });
}

test('RBAC-001 / FMA-01: finance-management maps to finance + store-credit — not activity or returns', () => {
  const mapped = TEAM_PERMISSION_TO_ROUTE_MODULES['finance-management'];
  assert.deepEqual(mapped, ['finance', 'store-credit']);
  assert.equal(canAccessRouteModule(['finance-management'], 'store-credit'), true);
  assert.equal(canAccessRouteModule(['finance-management'], 'finance'), true);
  assert.equal(canAccessRouteModule(['finance-management'], 'activity'), false);
  assert.equal(canAccessRouteModule(['finance-management'], 'returns'), false);
  assert.equal(canAccessRouteModule(['finance-management'], 'inspection'), false);
});

test('FMA-01 / REQ-02: activity-log is a separate team permission for activity routes', () => {
  assert.deepEqual(TEAM_PERMISSION_TO_ROUTE_MODULES['activity-log'], ['activity']);
  assert.equal(canAccessRouteModule(['activity-log'], 'activity'), true);
  assert.equal(canAccessRouteModule(['activity-log'], 'finance'), false);
  assert.equal(canAccessRouteModule(['finance-management', 'activity-log'], 'activity'), true);
});

test('RBAC-001: returns-refurbishment maps to returns + inspection — not store-credit', () => {
  assert.equal(canAccessRouteModule(['returns-refurbishment'], 'returns'), true);
  assert.equal(canAccessRouteModule(['returns-refurbishment'], 'inspection'), true);
  assert.equal(canAccessRouteModule(['returns-refurbishment'], 'store-credit'), false);
  assert.equal(canAccessRouteModule(['returns-refurbishment'], 'finance'), false);
});

test('RBAC-001: Finance team can see store-credit UI module but not returns', () => {
  const finance = { role: 'ADMIN_TEAM', adminModules: ['finance-management'] };
  assert.equal(userCanSeeModule(finance, 'store-credit'), true);
  assert.equal(userCanSeeModule(finance, 'finance'), true);
  assert.equal(userCanSeeModule(finance, 'returns'), false);
  assert.equal(userCanSeeModule(finance, 'inspection'), false);
});

test('RBAC-001: Admin can see store-credit and returns', () => {
  const admin = { role: 'ADMIN', adminModules: null };
  assert.equal(userCanSeeModule(admin, 'store-credit'), true);
  assert.equal(userCanSeeModule(admin, 'returns'), true);
});

test('RBAC-001: Finance allowed on store-credit route middleware', async () => {
  const finance = { role: 'ADMIN_TEAM', adminModules: ['finance-management'] };
  const err = await runMiddleware(requireConsoleModule('store-credit'), finance);
  assert.equal(err, null);
});

test('RBAC-001: Finance forbidden on returns|inspection API middleware', async () => {
  const finance = { role: 'ADMIN_TEAM', adminModules: ['finance-management'] };
  const err = await runMiddleware(requireConsoleModuleAny(['returns', 'inspection']), finance);
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 403);
});

test('RBAC-001: Returns team allowed on returns API; forbidden on store-credit', async () => {
  const returnsTeam = { role: 'ADMIN_TEAM', adminModules: ['returns-refurbishment'] };
  assert.equal(await runMiddleware(requireConsoleModuleAny(['returns', 'inspection']), returnsTeam), null);
  const storeCreditErr = await runMiddleware(requireConsoleModule('store-credit'), returnsTeam);
  assert.ok(storeCreditErr instanceof AppError);
  assert.equal(storeCreditErr.statusCode, 403);
});

test('RBAC-001: Unauthorized team role cannot access store-credit or returns', async () => {
  const orders = { role: 'ADMIN_TEAM', adminModules: ['order-management'] };
  const storeCreditErr = await runMiddleware(requireConsoleModule('store-credit'), orders);
  const returnsErr = await runMiddleware(requireConsoleModuleAny(['returns', 'inspection']), orders);
  assert.ok(storeCreditErr instanceof AppError && storeCreditErr.statusCode === 403);
  assert.ok(returnsErr instanceof AppError && returnsErr.statusCode === 403);
});

test('RBAC-001: Admin bypasses store-credit and returns gates', async () => {
  const admin = { role: 'ADMIN' };
  assert.equal(await runMiddleware(requireConsoleModule('store-credit'), admin), null);
  assert.equal(await runMiddleware(requireConsoleModuleAny(['returns', 'inspection']), admin), null);
});

test('RBAC-001: store-credit activity route uses store-credit module only (not returns)', () => {
  const adminRoutes = readFileSync(join(__dirname, '../routes/admin.js'), 'utf8');
  assert.match(adminRoutes, /\/store-credit\/activity/);
  assert.match(adminRoutes, /requireConsoleModule\('store-credit'\)/);
  assert.match(adminRoutes, /listStoreCreditActivity/);

  const returnsRoutes = readFileSync(join(__dirname, '../routes/returns.js'), 'utf8');
  assert.doesNotMatch(returnsRoutes, /store-credit/);

  // FE must not call broad returns list for this page
  const storeCreditPage = readFileSync(
    join(__dirname, '../../admin-fe/app/(private)/admin/(console)/store-credit/page.tsx'),
    'utf8'
  );
  assert.match(storeCreditPage, /\/admin\/store-credit\/activity/);
  assert.equal(
    /client\.get[^;]*\/returns\/admin\/all/.test(storeCreditPage),
    false,
    'store-credit page must not call returns admin list'
  );
});

test('RBAC-001: finance-management does not accidentally gain returns via mapping expansion', () => {
  for (const [teamModule, routes] of Object.entries(TEAM_PERMISSION_TO_ROUTE_MODULES)) {
    if (teamModule === 'finance-management') {
      assert.ok(!routes.includes('returns'));
      assert.ok(!routes.includes('inspection'));
      assert.ok(routes.includes('store-credit'));
    }
    if (teamModule === 'returns-refurbishment') {
      assert.ok(!routes.includes('store-credit'));
      assert.ok(!routes.includes('finance'));
    }
  }
});
