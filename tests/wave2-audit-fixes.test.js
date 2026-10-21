import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertJwtSecret } from '../lib/jwt-secret.js';
import { localRemainingRefundableUsd } from '../lib/order-refund-balance.js';
import { isPrivateUploadPath } from '../lib/private-upload-access.js';
import { requireConsoleModuleAny } from '../middleware/admin-console.js';
import { AppError } from '../utils/error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('SEC-02: deployed environments reject the default and short JWT secrets', () => {
  assert.throws(() => assertJwtSecret('JWT_SECRET', 'your-secret-key-change-in-production', 'production'));
  assert.throws(() => assertJwtSecret('JWT_SECRET', 'short', 'staging'));
  assert.throws(() => assertJwtSecret('JWT_SECRET', '', 'production'));
  assert.doesNotThrow(() =>
    assertJwtSecret('JWT_SECRET', 'a-unique-production-secret-at-least-32', 'production')
  );
  assert.doesNotThrow(() => assertJwtSecret('JWT_SECRET', 'your-secret-key-change-in-production', 'development'));
  assert.doesNotThrow(() => assertJwtSecret('JWT_SECRET', 'short', 'test'));
});

test('SEC-04: team invites send a set-password link and do not email a password', () => {
  const admin = readFileSync(join(__dirname, '../services/admin.service.js'), 'utf8');
  const template = readFileSync(join(__dirname, '../packages/brand/email/templates.js'), 'utf8');
  assert.match(admin, /crypto\.randomBytes\(32\)/);
  assert.match(admin, /passwordResetToken\.create/);
  assert.doesNotMatch(admin, /Math\.random\(\)\.toString\(36\)/);
  assert.doesNotMatch(admin, /temporaryPassword/);
  assert.doesNotMatch(template, /Temporary password/);
  assert.match(template, /Set your password/);
});

test('RBAC-01: inventory-only staff cannot refund, settle, or print a return label', async () => {
  const inventoryOnly = { role: 'ADMIN_TEAM', adminModules: ['inventory-management'] };
  const guard = requireConsoleModuleAny(['returns', 'finance']);
  const err = await new Promise((resolve) => {
    guard({ user: inventoryOnly }, {}, (error) => resolve(error ?? null));
  });
  assert.ok(err instanceof AppError);
  assert.equal(err.statusCode, 403);

  const returnsTeam = { role: 'ADMIN_TEAM', adminModules: ['returns-refurbishment'] };
  const ok = await new Promise((resolve) => {
    guard({ user: returnsTeam }, {}, (error) => resolve(error ?? null));
  });
  assert.equal(ok, null);
});

test('PAY-03: refunded cents reduce what is left without replacing the original total', () => {
  assert.equal(
    localRemainingRefundableUsd({ totalAmount: 90.4, refundedAmountCents: 2000 }),
    70.4
  );
  assert.equal(localRemainingRefundableUsd({ totalAmount: 40 }), 40);
  const payment = readFileSync(join(__dirname, '../services/payment.service.js'), 'utf8');
  const refundFn = payment.slice(
    payment.indexOf('async function markOrderRefundedBySessionId'),
    payment.indexOf('async function getCheckoutSessionIdFromPaymentIntent')
  );
  assert.match(refundFn, /refundedAmountCents: amountRefundedCents/);
  assert.doesNotMatch(refundFn, /totalAmount: nextTotalUsd/);
});

test('DAT-01: financial user relations do not cascade on delete', () => {
  const schema = readFileSync(join(__dirname, '../prisma/schema.prisma'), 'utf8');
  const order = schema.slice(schema.indexOf('model Order {'), schema.indexOf('model MembershipShareCode'));
  const wallet = schema.slice(schema.indexOf('model StoreCreditWallet'), schema.indexOf('model StoreCreditTransaction'));
  assert.match(order, /user\s+User\s+@relation\([^)]*onDelete: Restrict/);
  assert.match(wallet, /onDelete: Restrict/);
});

test('SEC-05: return photos and shipping labels are private upload paths', () => {
  assert.equal(isPrivateUploadPath('/returns/photo.jpg'), true);
  assert.equal(isPrivateUploadPath('/shipping-labels/label.pdf'), true);
  assert.equal(isPrivateUploadPath('/products/hero.jpg'), false);
});
