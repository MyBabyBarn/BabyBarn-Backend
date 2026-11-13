import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANUAL_ORDER_STATUS_REJECTIONS,
  ORDER_STATUS_MANUAL_UPDATE_NOT_ALLOWED,
  classifyManualOrderStatusRequest,
  rejectManualOrderStatusUpdate,
} from '../lib/order-status-manual-update.js';
import { AppError } from '../utils/error-handler.js';
import { requireConsoleModule } from '../middleware/admin-console.js';
import { postPaymentFulfillmentFields } from '../lib/order-fulfillment-start.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REJECTED = [
  'PENDING',
  'PROCESSING',
  'CONFIRMED',
  'SHIPPED',
  'DELIVERED',
  'RETURNED',
  'REFUNDED',
];

test('ORD-001 P2: only CANCELLED is classified as cancel; others reject', () => {
  assert.equal(classifyManualOrderStatusRequest('CANCELLED'), 'cancel');
  assert.equal(classifyManualOrderStatusRequest('cancelled'), 'cancel');
  for (const status of REJECTED) {
    assert.equal(classifyManualOrderStatusRequest(status), 'reject');
  }
});

test('ORD-001 P2: manual status updates throw ORDER_STATUS_MANUAL_UPDATE_NOT_ALLOWED', () => {
  for (const status of REJECTED) {
    assert.throws(
      () => rejectManualOrderStatusUpdate(status),
      (err) =>
        err instanceof AppError &&
        err.statusCode === 400 &&
        err.code === ORDER_STATUS_MANUAL_UPDATE_NOT_ALLOWED &&
        Boolean(err.details?.useInstead)
    );
  }
});

test('ORD-001 P2: rejection messages guide to domain actions', () => {
  assert.match(MANUAL_ORDER_STATUS_REJECTIONS.SHIPPED.useInstead, /mark_shipped/);
  assert.match(MANUAL_ORDER_STATUS_REJECTIONS.DELIVERED.useInstead, /mark_delivered/);
  assert.match(MANUAL_ORDER_STATUS_REJECTIONS.REFUNDED.useInstead, /refund/i);
  assert.match(MANUAL_ORDER_STATUS_REJECTIONS.RETURNED.useInstead, /return/i);
  assert.match(MANUAL_ORDER_STATUS_REJECTIONS.CONFIRMED.message, /not an operational state/i);
});

test('ORD-001 P2: updateOrderStatus rejects free-form writes; CANCELLED uses finalize', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  assert.match(orderSvc, /rejectManualOrderStatusUpdate/);
  assert.match(orderSvc, /classifyManualOrderStatusRequest/);
  assert.match(orderSvc, /finalizeOrderCancellation/);
  assert.match(orderSvc, /via:\s*'admin_cancel'/);
  assert.doesNotMatch(
    orderSvc,
    /async updateOrderStatus[\s\S]*?data:\s*\{\s*status\s*\}/
  );
});

test('ORD-001 P2: mark_shipped and mark_delivered still cache Order.status + deliveredAt', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  const fulfillmentBlock = orderSvc.slice(
    orderSvc.indexOf("action === 'mark_shipped'"),
    orderSvc.indexOf("action === 'reject_unpaid'")
  );
  assert.match(fulfillmentBlock, /fulfillmentStatus = 'SHIPPED'/);
  assert.match(fulfillmentBlock, /data\.status = 'SHIPPED'/);
  assert.match(fulfillmentBlock, /fulfillmentStatus = 'DELIVERED'/);
  assert.match(fulfillmentBlock, /data\.status = 'DELIVERED'/);
  assert.match(fulfillmentBlock, /deliveredAt = new Date\(\)/);
});

test('ORD-001 P2: refund and payment paths still write derived Order.status', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  assert.match(orderSvc, /paymentStatus === 'REFUNDED'[\s\S]*?status:\s*nextStatus|nextStatus[\s\S]*?REFUNDED/);
  assert.match(orderSvc, /status:\s*'PROCESSING'/);
  assert.match(orderSvc, /postPaymentFulfillmentFields/);
  assert.deepEqual(postPaymentFulfillmentFields(new Date('2026-08-10T12:00:00.000Z')), {
    fulfillmentStatus: 'ACCEPTED',
    fulfillmentAcceptedAt: new Date('2026-08-10T12:00:00.000Z'),
  });
});

test('ORD-001 P2: historical CONFIRMED / RETURNED / SHIPPED / DELIVERED remain readable enums', () => {
  const schema = readFileSync(join(__dirname, '../prisma/schema.prisma'), 'utf8');
  assert.match(schema, /enum OrderStatus \{[\s\S]*CONFIRMED[\s\S]*RETURNED[\s\S]*\}/);
  const badgePath = join(__dirname, '../../admin-fe/components/admin/AdminOrderStatusBadge.tsx');
  if (existsSync(badgePath)) {
    const badge = readFileSync(badgePath, 'utf8');
    assert.match(badge, /status/);
  }
});

test('ORD-001 P2: status route still requires orders module; unauthorized team blocked', async () => {
  const routes = readFileSync(join(__dirname, '../routes/orders.js'), 'utf8');
  assert.match(
    routes,
    /'\/:id\/status'[\s\S]*?requireConsoleModule\('orders'\)[\s\S]*?updateOrderStatus/
  );

  const shippingOnly = { role: 'ADMIN_TEAM', adminModules: ['inventory-management'] };
  const err = await new Promise((resolve) => {
    requireConsoleModule('orders')({ user: shippingOnly }, {}, (e) => resolve(e ?? null));
  });
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 403);

  const ordersTeam = { role: 'ADMIN_TEAM', adminModules: ['order-management'] };
  const ok = await new Promise((resolve) => {
    requireConsoleModule('orders')({ user: ordersTeam }, {}, (e) => resolve(e ?? null));
  });
  assert.equal(ok, null);
});

test('ORD-001 P2: admin order detail no longer has Apply status free-form control', {
  skip: !existsSync(join(__dirname, '../../admin-fe')),
}, () => {
  const page = readFileSync(
    join(__dirname, '../../admin-fe/app/(private)/admin/(console)/orders/[id]/page.tsx'),
    'utf8'
  );
  assert.doesNotMatch(page, /Apply status/);
  assert.doesNotMatch(page, /STATUSES\.map/);
  assert.match(page, /Cancel order/);
  assert.match(page, /AdminOrderFulfillmentStepper/);
  assert.match(page, /status:\s*'CANCELLED'/);
});

test('ORD-001 P2 deferred notes: P3/P4 label+tracking sync addressed', () => {
  const orderSvc = readFileSync(join(__dirname, '../services/order.service.js'), 'utf8');
  const shippingCtrl = readFileSync(
    join(__dirname, '../controllers/shipping.controller.js'),
    'utf8'
  );
  assert.match(orderSvc, /shouldManualShipFromTracking/);
  assert.match(orderSvc, /persistOutboundShippingLabel/);
  assert.match(shippingCtrl, /persistOutboundShippingLabel/);
  assert.doesNotMatch(shippingCtrl, /status:\s*'SHIPPED'/);
});
