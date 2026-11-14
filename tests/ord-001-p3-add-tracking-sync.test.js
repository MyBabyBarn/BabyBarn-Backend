import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPreShipOrderStatus,
  manualShipFromTrackingFields,
  shouldManualShipFromTracking,
} from '../lib/order-manual-ship-transition.js';
import { requireConsoleModuleAny } from '../middleware/admin-console.js';
import { AppError } from '../utils/error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('ORD-001 P3: pre-ship statuses match updateAdminShipping / addTracking gate', () => {
  assert.equal(isPreShipOrderStatus('PENDING'), true);
  assert.equal(isPreShipOrderStatus('PROCESSING'), true);
  assert.equal(isPreShipOrderStatus('CONFIRMED'), true);
  assert.equal(isPreShipOrderStatus('SHIPPED'), false);
  assert.equal(isPreShipOrderStatus('DELIVERED'), false);
  assert.equal(isPreShipOrderStatus('CANCELLED'), false);
});

test('ORD-001 P3: shouldManualShipFromTracking requires tracking + pre-ship status', () => {
  assert.equal(
    shouldManualShipFromTracking({ status: 'PROCESSING', trackingNumber: '1Z999' }),
    true
  );
  assert.equal(
    shouldManualShipFromTracking({ status: 'PROCESSING', fulfillmentStatus: 'PICKUP_READY', trackingNumber: '1Z999' }),
    true
  );
  assert.equal(shouldManualShipFromTracking({ status: 'SHIPPED', trackingNumber: '1Z999' }), false);
  assert.equal(shouldManualShipFromTracking({ status: 'DELIVERED', trackingNumber: '1Z999' }), false);
  assert.equal(shouldManualShipFromTracking({ status: 'PROCESSING', trackingNumber: '  ' }), false);
  assert.equal(shouldManualShipFromTracking({ status: 'PROCESSING', trackingNumber: null }), false);
});

test('ORD-001 P3: manual ship fields set status + fulfillment + outboundShippedAt together', () => {
  const at = new Date('2026-08-10T18:00:00.000Z');
  assert.deepEqual(manualShipFromTrackingFields(at), {
    status: 'SHIPPED',
    fulfillmentStatus: 'SHIPPED',
    outboundShippedAt: at,
  });
});

test('ORD-001 P3: addTracking uses shared helper; no status-only ship', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  const addStart = orderSvc.indexOf('async addTracking(');
  const addEnd = orderSvc.indexOf('async resolveStripePaymentIntentId(');
  const block = orderSvc.slice(addStart, addEnd);
  assert.match(block, /shouldManualShipFromTracking/);
  assert.match(block, /manualShipFromTrackingFields/);
  assert.doesNotMatch(block, /\.\.\.\(statusWillShip \? \{ status: 'SHIPPED' \} : \{\}\)/);
  assert.match(block, /ORDER_TRACKING_ADDED/);
  assert.doesNotMatch(block, /FULFILLMENT_mark_shipped/);
  assert.doesNotMatch(block, /sendOrderTrackingEmail/);
});

test('ORD-001 P3: updateAdminShipping uses the same ship helper', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  const start = orderSvc.indexOf('async updateAdminShipping(');
  const end = orderSvc.indexOf('async getAdminShippingOptions(');
  const block = orderSvc.slice(start, end);
  assert.match(block, /shouldManualShipFromTracking/);
  assert.match(block, /manualShipFromTrackingFields/);
});

test('ORD-001 P3: mark_shipped still sets fulfillment + status + outboundShippedAt', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  const block = orderSvc.slice(
    orderSvc.indexOf("action === 'mark_shipped'"),
    orderSvc.indexOf("action === 'reject_unpaid'")
  );
  assert.match(block, /fulfillmentStatus = 'SHIPPED'/);
  assert.match(block, /outboundShippedAt = new Date\(\)/);
  assert.match(block, /data\.status = 'SHIPPED'/);
});

test('ORD-001 P3: UPS label generation still sets LABEL_GENERATED, not SHIPPED', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  const helper = readFileSync(join(__dirname, '../lib/order-outbound-label-persist.js'), 'utf8');
  const start = orderSvc.indexOf('async generateAdminShippingLabel(');
  const end = orderSvc.indexOf('async generateAdminUpsLabel(');
  const block = orderSvc.slice(start, end);
  assert.match(block, /persistOutboundShippingLabel/);
  assert.match(helper, /fulfillmentStatus = 'LABEL_GENERATED'|fulfillmentStatus:\s*'LABEL_GENERATED'/);
  assert.doesNotMatch(block, /status:\s*'SHIPPED'/);
  assert.doesNotMatch(helper, /status:\s*'SHIPPED'/);
});

test('ORD-001 P3: tracking route still requires orders|shipping module', async () => {
  const routes = readFileSync(join(__dirname, '../routes/orders.js'), 'utf8');
  assert.match(
    routes,
    /'\/:id\/tracking'[\s\S]*?ordersOrShipping[\s\S]*?updateTracking/
  );

  const finance = { role: 'ADMIN_TEAM', adminModules: ['finance-management'] };
  const err = await new Promise((resolve) => {
    requireConsoleModuleAny(['orders', 'shipping'])({ user: finance }, {}, (e) => resolve(e ?? null));
  });
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 403);

  const orders = { role: 'ADMIN_TEAM', adminModules: ['order-management'] };
  const ok = await new Promise((resolve) => {
    requireConsoleModuleAny(['orders', 'shipping'])({ user: orders }, {}, (e) => resolve(e ?? null));
  });
  assert.equal(ok, null);
});

test('ORD-001 P3: simulated addTracking ship transition for ACCEPTED and PICKUP_READY', () => {
  for (const fulfillmentStatus of ['ACCEPTED', 'PICKUP_READY']) {
    const order = { status: 'PROCESSING', fulfillmentStatus, outboundShippedAt: null };
    const trackingNumber = '1ZAAA';
    const shouldShip = shouldManualShipFromTracking({
      status: order.status,
      trackingNumber,
    });
    assert.equal(shouldShip, true);
    const data = {
      trackingNumber,
      ...(shouldShip ? manualShipFromTrackingFields(new Date('2026-08-10T12:00:00.000Z')) : {}),
    };
    assert.equal(data.status, 'SHIPPED');
    assert.equal(data.fulfillmentStatus, 'SHIPPED');
    assert.ok(data.outboundShippedAt);
  }
});

test('ORD-001 P3: already SHIPPED / DELIVERED do not re-apply ship fields', () => {
  const shippedAt = new Date('2026-08-01T00:00:00.000Z');
  for (const order of [
    { status: 'SHIPPED', fulfillmentStatus: 'SHIPPED', outboundShippedAt: shippedAt },
    {
      status: 'DELIVERED',
      fulfillmentStatus: 'DELIVERED',
      outboundShippedAt: shippedAt,
      deliveredAt: new Date('2026-08-05T00:00:00.000Z'),
    },
  ]) {
    const shouldShip = shouldManualShipFromTracking({
      status: order.status,
      trackingNumber: '1ZBBB',
    });
    assert.equal(shouldShip, false);
    const data = {
      trackingNumber: '1ZBBB',
      ...(shouldShip ? manualShipFromTrackingFields() : {}),
    };
    assert.equal(data.status, undefined);
    assert.equal(data.fulfillmentStatus, undefined);
    assert.equal(data.outboundShippedAt, undefined);
  }
});
