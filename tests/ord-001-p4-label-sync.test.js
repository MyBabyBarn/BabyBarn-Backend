import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertOrderAllowsOutboundLabelPersist,
  buildOutboundLabelPersistData,
  shouldSetPickupReadyFromOutboundLabel,
} from '../lib/order-outbound-label-persist.js';
import { AppError } from '../utils/error-handler.js';
import { requireConsoleModuleAny } from '../middleware/admin-console.js';
import {
  manualShipFromTrackingFields,
  shouldManualShipFromTracking,
} from '../lib/order-manual-ship-transition.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sampleLabel = {
  trackingNumber: '1Z999AA10123456784',
  shippingCarrier: 'UPS',
  shippingLabelUrl: '/uploads/shipping-labels/ups-demo.gif',
  transactionId: 'txn-demo',
};

test('ORD-001 P4: pre-ship ACCEPTED → LABEL_GENERATED + tracking; status not SHIPPED', () => {
  const order = {
    status: 'PROCESSING',
    fulfillmentStatus: 'ACCEPTED',
    fulfillmentAcceptedAt: new Date('2026-08-10T10:00:00.000Z'),
    outboundShippedAt: null,
  };
  const { data, setPickupReady } = buildOutboundLabelPersistData({
    order,
    label: sampleLabel,
    at: new Date('2026-08-10T12:00:00.000Z'),
  });
  assert.equal(setPickupReady, true);
  assert.equal(data.fulfillmentStatus, 'LABEL_GENERATED');
  assert.equal(data.trackingNumber, sampleLabel.trackingNumber);
  assert.equal(data.shippingCarrier, 'UPS');
  assert.equal(data.shippingLabelUrl, sampleLabel.shippingLabelUrl);
  assert.equal(data.shippingTransactionId, 'txn-demo');
  assert.ok(data.labelGeneratedAt);
  assert.equal(data.trackingStatus, 'LABEL_CREATED');
  assert.equal(data.status, undefined);
  assert.equal(data.outboundShippedAt, undefined);
  assert.equal(data.deliveredAt, undefined);
});

test('ORD-001 P4: without order mutation path — helper unused; controller skips persist', () => {
  const ctrl = readFileSync(join(__dirname, '../controllers/shipping.controller.js'), 'utf8');
  assert.match(ctrl, /if \(body\.orderId && label\.trackingNumber\)/);
  assert.match(ctrl, /persistOutboundShippingLabel/);
  assert.doesNotMatch(ctrl, /status:\s*'SHIPPED'/);
});

test('ORD-001 P4: already SHIPPED does not regress to PICKUP_READY', () => {
  const shippedAt = new Date('2026-08-01T00:00:00.000Z');
  const order = {
    status: 'SHIPPED',
    fulfillmentStatus: 'SHIPPED',
    outboundShippedAt: shippedAt,
  };
  assert.equal(shouldSetPickupReadyFromOutboundLabel(order), false);
  const { data, setPickupReady } = buildOutboundLabelPersistData({ order, label: sampleLabel });
  assert.equal(setPickupReady, false);
  assert.equal(data.fulfillmentStatus, undefined);
  assert.equal(data.trackingNumber, sampleLabel.trackingNumber);
  assert.equal(data.status, undefined);
  assert.equal(data.outboundShippedAt, undefined);
});

test('ORD-001 P4: DELIVERED does not regress', () => {
  const order = {
    status: 'DELIVERED',
    fulfillmentStatus: 'DELIVERED',
    deliveredAt: new Date('2026-08-05T00:00:00.000Z'),
    outboundShippedAt: new Date('2026-08-02T00:00:00.000Z'),
  };
  const { data, setPickupReady } = buildOutboundLabelPersistData({ order, label: sampleLabel });
  assert.equal(setPickupReady, false);
  assert.equal(data.fulfillmentStatus, undefined);
  assert.equal(data.status, undefined);
  assert.equal(data.deliveredAt, undefined);
  assert.equal(data.trackingNumber, sampleLabel.trackingNumber);
});

test('ORD-001 P4: CANCELLED / REFUNDED / RETURNED rejected', () => {
  for (const status of ['CANCELLED', 'REFUNDED', 'RETURNED']) {
    assert.throws(
      () => assertOrderAllowsOutboundLabelPersist({ status }),
      (err) => err instanceof AppError && err.code === 'ORDER_LABEL_NOT_ALLOWED'
    );
    assert.throws(
      () => buildOutboundLabelPersistData({ order: { status }, label: sampleLabel }),
      (err) => err instanceof AppError && err.code === 'ORDER_LABEL_NOT_ALLOWED'
    );
  }
});

test('ORD-001 P4: admin generateAdminShippingLabel uses shared persist; no SHIPPED', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  const start = orderSvc.indexOf('async generateAdminShippingLabel(');
  const end = orderSvc.indexOf('async generateAdminUpsLabel(');
  const block = orderSvc.slice(start, end);
  assert.match(block, /persistOutboundShippingLabel/);
  assert.doesNotMatch(block, /status:\s*'SHIPPED'/);
  assert.match(orderSvc, /buildOutboundLabelPersistData/);
});

test('ORD-001 P4: mark_shipped still ships; P3 manual ship helper unchanged', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  const block = orderSvc.slice(
    orderSvc.indexOf("action === 'mark_shipped'"),
    orderSvc.indexOf("action === 'reject_unpaid'")
  );
  assert.match(block, /fulfillmentStatus = 'SHIPPED'/);
  assert.match(block, /outboundShippedAt = new Date\(\)/);

  assert.equal(
    shouldManualShipFromTracking({ status: 'PROCESSING', trackingNumber: '1Z' }),
    true
  );
  assert.deepEqual(manualShipFromTrackingFields(new Date('2026-08-10T00:00:00.000Z')).fulfillmentStatus, 'SHIPPED');
});

test('ORD-001 P4: return LABEL_GENERATED path untouched (returns.service)', () => {
  const returns = readFileSync(join(__dirname, '../services/returns.service.js'), 'utf8');
  assert.match(returns, /status:\s*'LABEL_GENERATED'/);
  assert.match(returns, /RETURN_LABEL_GENERATED/);
});

test('ORD-001 P4: /shipping/labels still requires orders|shipping', async () => {
  const routes = readFileSync(join(__dirname, '../routes/shipping.js'), 'utf8');
  assert.match(routes, /'\/labels'[\s\S]*?ordersOrShipping[\s\S]*?generateLabel/);

  const finance = { role: 'ADMIN_TEAM', adminModules: ['finance-management'] };
  const err = await new Promise((resolve) => {
    requireConsoleModuleAny(['orders', 'shipping'])({ user: finance }, {}, (e) => resolve(e ?? null));
  });
  assert.ok(err instanceof AppError && err.statusCode === 403);
});

test('ORD-001 P4-IDEMP: label rebuy limitation remains documented in controller', () => {
  const ctrl = readFileSync(join(__dirname, '../controllers/shipping.controller.js'), 'utf8');
  assert.match(ctrl, /ORD-001-P4-IDEMP/);
});
