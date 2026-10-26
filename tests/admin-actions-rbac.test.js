import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeAdminAccess,
  hasTeamAction,
  modulesFromAccess,
  actionIdsForModule,
} from '../constants/admin-actions.js';
import { canAccessRouteModule, normalizeTeamAccessPayload } from '../constants/admin-modules.js';

describe('admin action-level RBAC', () => {
  it('expands legacy module arrays to full action sets', () => {
    const access = normalizeAdminAccess(['order-management']);
    assert.ok(access['order-management'].includes('view'));
    assert.ok(access['order-management'].includes('pick'));
    assert.ok(access['order-management'].includes('export'));
  });

  it('filters unknown actions from maps', () => {
    const access = normalizeAdminAccess({
      'order-management': ['view', 'hack', 'cancel'],
    });
    assert.deepEqual(access['order-management'].sort(), ['cancel', 'view']);
  });

  it('gates team actions', () => {
    const access = { 'order-management': ['view', 'pick'] };
    assert.equal(hasTeamAction(access, 'order-management', 'pick'), true);
    assert.equal(hasTeamAction(access, 'order-management', 'cancel'), false);
    assert.equal(hasTeamAction(['order-management'], 'order-management', 'cancel'), true);
  });

  it('maps action access to route modules including pickup and ledger', () => {
    const access = normalizeTeamAccessPayload({
      'order-management': ['view', 'pick'],
      'inventory-management': ['view', 'export'],
    });
    assert.equal(canAccessRouteModule(access, 'orders'), true);
    assert.equal(canAccessRouteModule(access, 'pickup'), true);
    assert.equal(canAccessRouteModule(access, 'ledger'), true);
    assert.equal(canAccessRouteModule(access, 'finance'), false);
  });

  it('lists modules from access', () => {
    assert.deepEqual(modulesFromAccess(['activity-log']).sort(), ['activity-log']);
    assert.ok(actionIdsForModule('finance-management').includes('refund'));
  });
});
