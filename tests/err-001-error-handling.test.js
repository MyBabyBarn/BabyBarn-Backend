import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(__dirname, '..');
const monoRoot = join(__dirname, '../..');
const isMonorepo = existsSync(join(monoRoot, 'admin-fe'));
const root = isMonorepo ? monoRoot : backendRoot;

function read(rel) {
  const path =
    !isMonorepo && rel.startsWith('backend/') ? rel.slice('backend/'.length) : rel;
  return readFileSync(join(root, path), 'utf8');
}

function hasSibling(name) {
  return isMonorepo && existsSync(join(monoRoot, name));
}

/** Mirrors admin-fe/lib/classify-financial-api-error.ts for regression. */
function classifyFinancialApiError(error, fallback) {
  const code =
    error?.response?.data?.code && typeof error.response.data.code === 'string'
      ? error.response.data.code
      : null;
  const message =
    (typeof error?.response?.data?.message === 'string' && error.response.data.message.trim()) ||
    fallback;

  if (code === 'RETURN_REFUND_PERSIST_FAILED' || code === 'ORDER_REFUND_PERSIST_FAILED') {
    return { kind: 'unknown_outcome', code, message, retryable: false };
  }
  if (code === 'STRIPE_REFUND_FAILED' || code === 'STRIPE_BALANCE_UNAVAILABLE') {
    return { kind: 'safe_retry', code, message, retryable: true };
  }
  if (code === 'ALREADY_REFUNDED' || code === 'ALREADY_SETTLED') {
    return { kind: 'already_done', code, message, retryable: false };
  }
  const status = error?.response?.status;
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409) {
    return { kind: 'non_retryable', code, message, retryable: false };
  }
  if (error?.code === 'ERR_NETWORK' || error?.code === 'ECONNABORTED') {
    return { kind: 'unknown_outcome', code, message, retryable: false };
  }
  return { kind: 'generic', code, message, retryable: false };
}

function extractApiError(error, fallback) {
  const msg = error?.response?.data?.message;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  const status = error?.response?.status;
  if (status === 403) return 'You do not have permission to perform this action.';
  if (status === 401) return 'Your session expired. Please sign in again.';
  if (status === 404) return 'The requested record was not found. Refresh and try again.';
  if (status === 409) return 'This record was updated by another user. Refresh to continue.';
  if (error?.code === 'ERR_NETWORK') {
    return 'Cannot reach the API server. Start the backend on port 5000 (npm run dev in /backend).';
  }
  if (error?.code === 'ECONNABORTED') {
    return 'The request timed out. We could not confirm the result — refresh before trying again.';
  }
  return fallback;
}

test('ERR-001: API error shape stays success/code/message', () => {
  const src = read('backend/utils/error-handler.js');
  assert.ok(src.includes('success: false'));
  assert.ok(src.includes('code:'));
  assert.ok(src.includes('message:'));
  assert.ok(src.includes('class AppError'));
});

test('ERR-001: validation / 401 / 403 / 404 / 409 messages', () => {
  assert.equal(
    extractApiError({ response: { status: 403, data: {} } }, 'x'),
    'You do not have permission to perform this action.'
  );
  assert.equal(
    extractApiError({ response: { status: 401, data: {} } }, 'x'),
    'Your session expired. Please sign in again.'
  );
  assert.equal(
    extractApiError({ response: { status: 404, data: {} } }, 'x'),
    'The requested record was not found. Refresh and try again.'
  );
  assert.equal(
    extractApiError({ response: { status: 409, data: {} } }, 'x'),
    'This record was updated by another user. Refresh to continue.'
  );
  assert.equal(
    extractApiError({ response: { status: 400, data: { message: 'Email is required' } } }, 'x'),
    'Email is required'
  );
});

test('ERR-001: network/timeout → unknown confirmation language', () => {
  const msg = extractApiError({ code: 'ECONNABORTED' }, 'fallback');
  assert.match(msg, /could not confirm/i);
  const net = extractApiError({ code: 'ERR_NETWORK' }, 'fallback');
  assert.match(net, /Cannot reach/i);
});

test('ERR-001: financial safe_retry vs unknown_outcome', () => {
  const safe = classifyFinancialApiError(
    { response: { data: { code: 'STRIPE_REFUND_FAILED', message: 'No local refund was recorded — safe to retry.' } } },
    'Refund failed'
  );
  assert.equal(safe.kind, 'safe_retry');
  assert.equal(safe.retryable, true);

  const unknown = classifyFinancialApiError(
    {
      response: {
        data: {
          code: 'RETURN_REFUND_PERSIST_FAILED',
          message: 'Stripe refund succeeded but local persistence failed.',
        },
      },
    },
    'Refund failed'
  );
  assert.equal(unknown.kind, 'unknown_outcome');
  assert.equal(unknown.retryable, false);

  const orderPersist = classifyFinancialApiError(
    { response: { data: { code: 'ORDER_REFUND_PERSIST_FAILED', message: 'persist failed' } } },
    'x'
  );
  assert.equal(orderPersist.kind, 'unknown_outcome');
  assert.equal(orderPersist.retryable, false);
});

test('ERR-001: non-retryable conflict/permission', () => {
  const forbidden = classifyFinancialApiError({ response: { status: 403, data: {} } }, 'x');
  assert.equal(forbidden.kind, 'non_retryable');
  assert.equal(forbidden.retryable, false);

  const conflict = classifyFinancialApiError({ response: { status: 409, data: { message: 'stale' } } }, 'x');
  assert.equal(conflict.kind, 'non_retryable');
});

test('ERR-001: FE wires financial classifier on refund/settle/cancel', { skip: !hasSibling('admin-fe') }, () => {
  const detail = read('admin-fe/components/admin/returns/standard/StandardReturnDetailView.tsx');
  const order = read('admin-fe/app/(private)/admin/(console)/orders/[id]/page.tsx');
  assert.ok(detail.includes('classifyFinancialApiError'));
  assert.ok(order.includes('classifyFinancialApiError'));
  assert.ok(order.includes('useSubmitLock'));
});

test('ERR-001: list pages gate empty tables behind loadError + Retry', { skip: !hasSibling('admin-fe') }, () => {
  const orders = read('admin-fe/app/(private)/admin/(console)/orders/page.tsx');
  const returns = read('admin-fe/app/(private)/admin/(console)/returns/page.tsx');
  const inspection = read('admin-fe/app/(private)/admin/(console)/inspection/page.tsx');
  assert.ok(orders.includes('reloadList()'));
  assert.ok(orders.includes('Orders could not be loaded'));
  assert.ok(returns.includes('Returns could not be loaded'));
  assert.ok(inspection.includes('Queue could not be loaded'));
});

test('ERR-001: customer extractApiError + returns Retry', { skip: !hasSibling('customer-fe') }, () => {
  const helper = read('customer-fe/lib/extract-api-error.ts');
  const page = read('customer-fe/app/(private)/dashboard/returns/page.tsx');
  assert.ok(helper.includes('extractApiError'));
  assert.ok(page.includes('extractApiError'));
  assert.ok(page.includes('Retry'));
});

test('ERR-001: job-lease records failure and logs release errors', () => {
  const lease = read('backend/lib/job-lease.js');
  assert.ok(lease.includes('JOB_LEASE_STATUS.FAILED'));
  assert.ok(lease.includes('failed to record FAILED status'));
  assert.equal(/release\(\{[\s\S]*?\}\)\.catch\(\(\) => \{\}\)/.test(lease), false);
});

test('ERR-001: inventory adjust + history no longer silent', { skip: !hasSibling('admin-fe') }, () => {
  const modal = read('admin-fe/components/inventory/InventoryAdjustModal.tsx');
  const ledger = read('admin-fe/components/admin/inventory/AdminInventoryLedgerConsole.tsx');
  assert.ok(modal.includes('extractApiError'));
  assert.ok(ledger.includes('Could not load inventory ledger'));
});

test('ERR-001: financial domain codes unchanged in services', () => {
  const refund = read('backend/services/return-refund.service.js');
  const order = read('backend/services/order.service.js');
  assert.ok(refund.includes('RETURN_REFUND_PERSIST_FAILED'));
  assert.ok(refund.includes('STRIPE_REFUND_FAILED'));
  assert.ok(order.includes('ORDER_REFUND_PERSIST_FAILED'));
});
