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

/** Mirrors admin-fe draftReadyForHappyPathSettle (WH-001). */
function draftReadyForHappyPathSettle(draft, returnedQty) {
  if (returnedQty <= 0) return false;
  if (draft.acceptedQuantity + draft.rejectedQuantity !== returnedQty) return false;
  if (draft.acceptedQuantity <= 0) return false;
  if (draft.rejectedQuantity > 0) return false;
  if (String(draft.disposition || '').toUpperCase() !== 'RESTOCK') return false;
  const keys = [
    'correctProduct',
    'unused',
    'tagsAttached',
    'packagingAvailable',
    'noStains',
    'noDamage',
    'noMissingAccessories',
  ];
  if (!keys.every((k) => draft.checklist?.[k] === true)) return false;
  return true;
}

/** Mirrors formatAdminReturnStatus APPROVED distinction (WH-002). */
function formatAdminReturnStatus(status, opts = {}) {
  const type = String(opts.type || '').toUpperCase();
  if (type === 'REFURBISHMENT') {
    const map = {
      APPROVED: 'Approved — eligibility approved',
      UNDER_INSPECTION: 'Physical inspection',
      INSPECTION_APPROVED: 'Inspection approved — product accepted',
    };
    return map[status] || status;
  }
  if (status === 'APPROVED') {
    if (opts.refundedAt || opts.stripeRefundId) {
      if (opts.restockedAt) return 'Completed — refunded & restocked';
      return 'Approved — refunded';
    }
    return 'Approved — inspection accepted';
  }
  return status;
}

test('WH-001: happy-path settle draft requires RESTOCK + full accept + checklist', () => {
  const checklist = {
    correctProduct: true,
    unused: true,
    tagsAttached: true,
    packagingAvailable: true,
    noStains: true,
    noDamage: true,
    noMissingAccessories: true,
  };
  assert.equal(
    draftReadyForHappyPathSettle(
      { acceptedQuantity: 2, rejectedQuantity: 0, disposition: 'RESTOCK', checklist },
      2
    ),
    true
  );
  assert.equal(
    draftReadyForHappyPathSettle(
      { acceptedQuantity: 2, rejectedQuantity: 0, disposition: 'DISCARD', checklist },
      2
    ),
    false
  );
  assert.equal(
    draftReadyForHappyPathSettle(
      { acceptedQuantity: 1, rejectedQuantity: 1, disposition: 'RESTOCK', checklist },
      2
    ),
    false
  );
  assert.equal(
    draftReadyForHappyPathSettle(
      {
        acceptedQuantity: 2,
        rejectedQuantity: 0,
        disposition: 'RESTOCK',
        checklist: { ...checklist, noDamage: false },
      },
      2
    ),
    false
  );
});

test('WH-001: Approve & Settle already consolidates approve→refund→restock (no duplicate service)', () => {
  const src = read('backend/services/returns.service.js');
  assert.ok(src.includes('async approveAndSettle'));
  assert.ok(src.includes('evaluateStandardSettleEligibility'));
  assert.ok(src.includes('processStandardReturnRefund'));
  assert.ok(src.includes('restockStandardLinesExplicit'));
  // Financial order preserved: refund before restock in settle path
  const settleStart = src.indexOf('async approveAndSettle');
  const settleBody = src.slice(settleStart, settleStart + 8000);
  const refundIdx = settleBody.indexOf('processStandardReturnRefund');
  const restockIdx = settleBody.indexOf('restockStandardLinesExplicit');
  assert.ok(refundIdx > 0 && restockIdx > refundIdx);
});

test('WH-001: FE card exposes save-then-settle to remove Complete→Settle double click', { skip: !hasSibling('admin-fe') }, () => {
  const card = read(
    'admin-fe/components/admin/returns/standard/ReturnProductInspectCard.tsx'
  );
  const detail = read(
    'admin-fe/components/admin/returns/standard/StandardReturnDetailView.tsx'
  );
  assert.ok(card.includes('draftReadyForHappyPathSettle'));
  assert.ok(card.includes('onSaveThenSettle'));
  assert.ok(card.includes('Approve & Settle unavailable:'));
  assert.ok(detail.includes('saveThenSettle'));
  assert.ok(detail.includes('Approve & Settle unavailable:'));
});

test('WH-002: Standard APPROVED ≠ Refurb APPROVED in display labels', () => {
  assert.equal(
    formatAdminReturnStatus('APPROVED', { type: 'STANDARD' }),
    'Approved — inspection accepted'
  );
  assert.equal(
    formatAdminReturnStatus('APPROVED', { type: 'REFURBISHMENT' }),
    'Approved — eligibility approved'
  );
  assert.equal(
    formatAdminReturnStatus('INSPECTION_APPROVED', { type: 'REFURBISHMENT' }),
    'Inspection approved — product accepted'
  );
  assert.notEqual(
    formatAdminReturnStatus('APPROVED', { type: 'STANDARD' }),
    formatAdminReturnStatus('APPROVED', { type: 'REFURBISHMENT' })
  );
});

test('WH-002: refurb pipeline labels no longer use cryptic Physical/Credit', { skip: !hasSibling('admin-fe') }, () => {
  const src = read('admin-fe/lib/refurb-inspection.ts');
  assert.ok(src.includes("UNDER_INSPECTION: 'Physical inspection'"));
  assert.ok(src.includes("INSPECTION_APPROVED: 'Inspection approved — product accepted'"));
  assert.ok(src.includes("APPROVED: 'Approved — eligibility approved'"));
  assert.equal(/UNDER_INSPECTION:\s*'Physical'/.test(src), false);
  assert.equal(/INSPECTION_APPROVED:\s*'Credit'/.test(src), false);
});

test('WH-002: admin returns list uses type-aware status chips', { skip: !hasSibling('admin-fe') }, () => {
  const page = read('admin-fe/app/(private)/admin/(console)/returns/page.tsx');
  assert.ok(page.includes('formatAdminReturnStatusChip'));
  assert.equal(/row\.status\.replace\(\/_\/g/.test(page), false);
});

test('WH-002: package receive CTA states package scope', { skip: !hasSibling('admin-fe') }, () => {
  const actions = read('admin-fe/components/admin/inspection/AdminRefurbReturnActions.tsx');
  const items = read('admin-fe/components/admin/inspection/AdminRefurbSubmissionItems.tsx');
  assert.ok(actions.includes('Mark package received (all items)'));
  assert.ok(items.includes('Mark package received (all items)'));
  assert.ok(items.includes('Receives the whole package'));
});

test('WH-001/002: no new financial or inventory bypass in FE settle path', { skip: !hasSibling('admin-fe') }, () => {
  const detail = read(
    'admin-fe/components/admin/returns/standard/StandardReturnDetailView.tsx'
  );
  // Still goes through existing approve-and-settle endpoint
  assert.ok(detail.includes('/approve-and-settle'));
  // Save-then-settle persists via inspect-line then confirm settle (domain services)
  assert.ok(detail.includes('/inspect-line'));
  assert.equal(detail.includes('stripe.refunds.create'), false);
});
