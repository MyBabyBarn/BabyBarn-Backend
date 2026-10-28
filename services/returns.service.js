import { prisma } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { AppError } from '../utils/error-handler.js';
import { writeAdminAudit } from './audit.service.js';
import { emailService } from './email.service.js';
import { getBusinessSettings } from './admin.service.js';
import { restockOrderLineStock } from './inventory-reservation.js';
import { writeInventoryLedger } from './inventory-ledger.service.js';
import { refurbishmentService } from './refurbishment.service.js';
import { markUnitsReturnedForReturn } from './product-unit.service.js';
import { shippingService } from './shipping.service.js';
import { notifyEligibilityReview, notifyInspectionQueued, notifyReturnRequest } from './admin-notification.service.js';
import {
  returnableQuantityForLine,
  TERMINAL_RETURN_REJECT_STATUSES,
} from '../lib/return-quantity-policy.js';
import { assertOrderLineEligibleForReturnType } from '../lib/return-product-eligibility.js';
import {
  buildDemoReturnLabel,
  demoTrackingNextStatus,
  isDemoReturnTracking,
  useDemoReturnLabels,
} from './shipping/demo-return-label.js';
import {
  evaluateRefurbQuestionnaire,
  initialReturnStatusForDecision,
} from './refurb-eligibility.service.js';
import { computeRefurbStoreCredit, getAccessUsedReturnWindowDays, refurbShipByDeadline } from '../config/refurb.config.js';
import { verifyOrderTrackingToken } from '../lib/order-tracking-token.js';
import { appendReturnStatusEvent, listReturnStatusEvents, appendReturnActionNote } from './return-status-events.service.js';
import {
  computeStandardReturnRefundAmount,
  processStandardReturnRefund,
} from './return-refund.service.js';
import { assignReturnNumber } from '../utils/return-number.js';
import { returnLedgerNote } from '../lib/inventory-ledger-notes.js';
import {
  buildAdminReturnListWhere,
  normalizeAdminListPagination,
} from '../lib/return-admin-list-query.js';

function isMissingWalletTableError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'P2021' || error.code === 'P2022')
  );
}

/** Strict standard ladder: Received → Inspection → Approve/Reject; refund/restock are separate actions.
 * REQUESTED → UNDER_INSPECTION is allowed only when the line already has receivedQuantity > 0 (enforced in updateStatus/inspectLine).
 */
const STANDARD_TRANSITIONS = {
  REQUESTED: ['RECEIVED', 'UNDER_INSPECTION'],
  RECEIVED: ['UNDER_INSPECTION'],
  UNDER_INSPECTION: ['APPROVED', 'REJECTED'],
  APPROVED: [],
  REJECTED: [],
};

const REFURB_TRANSITIONS = {
  REQUESTED: ['ELIGIBILITY_REVIEW', 'ELIGIBILITY_REJECTED', 'APPROVED', 'REJECTED'],
  ELIGIBILITY_REVIEW: ['APPROVED', 'ELIGIBILITY_REJECTED', 'REJECTED'],
  ELIGIBILITY_REJECTED: [],
  APPROVED: ['IN_TRANSIT', 'CANCELLED', 'REJECTED'],
  LABEL_GENERATED: ['IN_TRANSIT', 'RECEIVED', 'REJECTED'],
  IN_TRANSIT: ['RECEIVED', 'REJECTED'],
  RECEIVED: ['UNDER_INSPECTION'],
  UNDER_INSPECTION: ['INSPECTION_APPROVED', 'INSPECTION_REJECTED'],
  INSPECTION_APPROVED: [],
  INSPECTION_REJECTED: [],
  REJECTED: [],
  CANCELLED: [],
};

const returnInclude = {
  user: {
    select: {
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      isGuest: true,
      accessMemberUntil: true,
    },
  },
  order: {
    select: {
      id: true,
      publicId: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      deliveredAt: true,
      returnEnvelopeUsed: true,
      shippingCost: true,
      taxAmount: true,
      storeCreditApplied: true,
      totalAmount: true,
      orderItems: {
        select: {
          price: true,
          quantity: true,
        },
      },
    },
  },
  orderItem: {
    include: {
      product: {
        select: {
          publicId: true,
          name: true,
          productType: true,
          sku: true,
          slug: true,
          sizeAgeGroup: true,
          imageUrl: true,
          gallery: true,
        },
      },
      productVariant: {
        select: { publicId: true, sku: true, combination: true },
      },
    },
  },
  eligibilityQuestionnaire: true,
  inspectionRecords: { orderBy: { createdAt: 'desc' }, take: 10 },
  refurbishmentJob: {
    include: {
      listedProduct: { select: { publicId: true, name: true, slug: true, conditionGrade: true } },
      inspectionRecords: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
  },
};

/** SCALE-001: list rows only — no inspection history, eligibility, jobs, or order line aggregates. */
const returnListInclude = {
  user: {
    select: {
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
      isGuest: true,
      accessMemberUntil: true,
    },
  },
  order: {
    select: {
      id: true,
      publicId: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      deliveredAt: true,
      returnEnvelopeUsed: true,
    },
  },
  orderItem: {
    include: {
      product: {
        select: {
          publicId: true,
          name: true,
          productType: true,
          sku: true,
          slug: true,
          sizeAgeGroup: true,
          imageUrl: true,
        },
      },
      productVariant: {
        select: { publicId: true, sku: true, combination: true },
      },
    },
  },
};

async function resolveActorUserId(actor) {
  if (!actor?.id) return null;
  const user = await prisma.user.findUnique({ where: { publicId: actor.id }, select: { id: true } });
  return user?.id ?? null;
}

export function resolveStandardReturnWindowStart(order) {
  if (order?.deliveredAt) return new Date(order.deliveredAt);
  if (String(order?.status || '').toUpperCase().includes('DELIVER')) {
    return new Date(order.createdAt);
  }
  return null;
}

export function standardReturnWindowDaysLeft(order, windowDays = 30) {
  const start = resolveStandardReturnWindowStart(order);
  if (!start) return 0;
  const end = start.getTime() + windowDays * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000)));
}

export function resolveUsedReturnWindowStart(order) {
  return resolveStandardReturnWindowStart(order);
}

function returnSubmissionKey(row) {
  return row?.submissionPublicId || row?.submissionId || row?.publicId || row?.id;
}

/**
 * Resolve a return by line publicId, shared submissionPublicId, or SRT-/RRT- returnNumber.
 * Admin list/detail URLs use submission ids; some actions still pass a line publicId.
 */
async function resolveReturnRequestRow(returnPublicId, opts = {}) {
  const include = Object.prototype.hasOwnProperty.call(opts, 'include') ? opts.include : returnInclude;
  const raw = String(returnPublicId || '').trim();
  if (!raw) return null;

  const findArgs = include === undefined ? {} : { include };

  let row = await prisma.returnRequest.findUnique({
    where: { publicId: raw },
    ...findArgs,
  });
  if (row) return row;

  const upper = raw.toUpperCase();
  const or = [{ submissionPublicId: raw }, { returnNumber: raw }];
  if (upper !== raw) or.push({ returnNumber: upper });

  return prisma.returnRequest.findFirst({
    where: { OR: or },
    ...findArgs,
    orderBy: { createdAt: 'asc' },
  });
}

/** Units eligible for refund/restock preview after inspection outcomes. */
function refundableQuantityForRow(row) {
  if (row?.acceptedQuantity != null) return Math.max(0, Number(row.acceptedQuantity));
  if (row?.status === 'REJECTED') return 0;
  return Math.max(1, Number(row.quantity ?? 1));
}

function computeRowRefundPreview(row) {
  if (row?.type !== 'STANDARD' || !row?.orderItem) return null;
  const qty = refundableQuantityForRow(row);
  if (qty <= 0) return 0;
  return computeStandardReturnRefundAmount(row.orderItem, qty, row.order);
}

function lineRequestedQty(row) {
  return Math.max(1, Number(row.quantity ?? 1));
}

function lineReceivedQty(row) {
  return Math.max(0, Number(row.receivedQuantity ?? 0));
}

function lineHasRemaining(row) {
  return lineReceivedQty(row) < lineRequestedQty(row);
}

function deriveSubmissionStatus(rows) {
  if (!rows.length) return 'REQUESTED';
  const statuses = rows.map((row) => row.status);
  if (statuses.every((status) => status === statuses[0])) return statuses[0];

  const type = rows[0].type;
  if (type === 'STANDARD') {
    const hasRemaining = rows.some((row) => lineHasRemaining(row));
    const anyInspecting = statuses.includes('UNDER_INSPECTION');
    const anyReceived = statuses.includes('RECEIVED');
    const anyRequested = statuses.includes('REQUESTED');
    const anyApproved = statuses.includes('APPROVED');
    const anyRejected = statuses.includes('REJECTED');

    // Active inspection on any received line takes display priority.
    if (anyInspecting) return 'UNDER_INSPECTION';

    // Mixed decisions while other lines still arriving / waiting.
    if (anyApproved || anyRejected) {
      if (anyReceived) return 'RECEIVED';
      if (anyRequested || hasRemaining) return 'REQUESTED';
      if (anyApproved && !anyRejected) return 'APPROVED';
      if (anyRejected && !anyApproved) return 'REJECTED';
      return 'APPROVED';
    }

    // Partial receive: one line RECEIVED, siblings still REQUESTED — stay receivable.
    if (anyReceived && (anyRequested || hasRemaining)) return 'REQUESTED';
    if (anyReceived) return 'RECEIVED';
    if (anyRequested) return 'REQUESTED';
    return statuses[0];
  }

  if (statuses.every((status) => status === 'INSPECTION_APPROVED')) return 'INSPECTION_APPROVED';
  if (statuses.every((status) => ['ELIGIBILITY_REJECTED', 'INSPECTION_REJECTED', 'REJECTED'].includes(status))) {
    return statuses[0];
  }

  const refurbPriority = [
    'ELIGIBILITY_REVIEW',
    'APPROVED',
    'LABEL_GENERATED',
    'IN_TRANSIT',
    'RECEIVED',
    'UNDER_INSPECTION',
    'INSPECTION_APPROVED',
  ];
  for (const status of refurbPriority) {
    if (statuses.includes(status)) return status;
  }
  return statuses[0];
}

function buildSubmissionStatusEvents(rows) {
  return rows
    .flatMap((row) =>
      (row.statusEvents ?? []).map((event) => ({
        ...event,
        returnItemId: row.id || row.publicId,
        returnSubmissionId: returnSubmissionKey(row),
        itemName: row.orderItem?.product?.name || null,
        note:
          row.orderItem?.product?.name && event.note
            ? `${row.orderItem.product.name} — ${event.note}`
            : event.note || row.orderItem?.product?.name || null,
      }))
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function checklistComplete(checklist) {
  if (!checklist || typeof checklist !== 'object') return false;
  const keys = [
    'correctProduct',
    'unused',
    'tagsAttached',
    'packagingAvailable',
    'noStains',
    'noDamage',
    'noMissingAccessories',
  ];
  return keys.every((k) => checklist[k] === true);
}

function lineAcceptedQty(rr) {
  if (rr.acceptedQuantity != null) return Math.max(0, Number(rr.acceptedQuantity));
  if (rr.status === 'APPROVED') return Math.max(1, Number(rr.quantity || 1));
  return 0;
}

/**
 * Whether a STANDARD line can run Approve & Settle (approve → refund → restock).
 * Disposition must be explicitly RESTOCK. Does not check Stripe/order payment.
 */
function evaluateStandardSettleEligibility(rr) {
  if (!rr || rr.type !== 'STANDARD') {
    return { eligible: false, bucket: 'requires_action', reason: 'Not a standard return line' };
  }
  const accepted = lineAcceptedQty(rr);
  const received = Math.max(0, Number(rr.receivedQuantity ?? 0));
  const disposition = String(rr.disposition || '').toUpperCase();
  const refunded = Boolean(rr.stripeRefundId || rr.refundedAt);
  const restocked = Boolean(rr.restockedAt);

  if (rr.status === 'REJECTED' || (accepted <= 0 && ['APPROVED', 'REJECTED'].includes(rr.status))) {
    return { eligible: false, bucket: 'completed', reason: 'No accepted units to settle' };
  }
  if (refunded && restocked && accepted > 0) {
    return { eligible: false, bucket: 'completed', reason: 'Already refunded and restocked' };
  }
  if (received <= 0) {
    return { eligible: false, bucket: 'requires_action', reason: 'Not received yet' };
  }
  if (disposition !== 'RESTOCK') {
    return {
      eligible: false,
      bucket: 'requires_action',
      reason: disposition
        ? `Disposition is ${disposition} (Settle requires RESTOCK)`
        : 'Set disposition to RESTOCK before settling',
    };
  }
  if (accepted <= 0) {
    return { eligible: false, bucket: 'requires_action', reason: 'No accepted units' };
  }

  if (rr.status === 'APPROVED') {
    return { eligible: true, bucket: 'eligible', reason: null };
  }

  if (!['REQUESTED', 'RECEIVED', 'UNDER_INSPECTION'].includes(rr.status)) {
    return { eligible: false, bucket: 'requires_action', reason: `Cannot settle in status ${rr.status}` };
  }

  const rejected = Math.max(0, Number(rr.rejectedQuantity ?? 0));
  if (accepted + rejected !== received) {
    return {
      eligible: false,
      bucket: 'requires_action',
      reason: 'Accepted + rejected must equal received quantity',
    };
  }
  if (!checklistComplete(rr.inspectionChecklistJson)) {
    return { eligible: false, bucket: 'requires_action', reason: 'Inspection checklist incomplete' };
  }
  if (rejected > 0 && !String(rr.rejectionReason || '').trim()) {
    return { eligible: false, bucket: 'requires_action', reason: 'Rejection reason required' };
  }
  if (rejected > 0) {
    const photos = rr.inspectorPhotoUrlsJson;
    if (!Array.isArray(photos) || !photos.length) {
      return { eligible: false, bucket: 'requires_action', reason: 'Evidence photos required for rejected units' };
    }
  }

  return { eligible: true, bucket: 'eligible', reason: null };
}

/**
 * Restock specific STANDARD lines without requiring all siblings decided.
 * Caller must pass only APPROVED lines with accepted qty and RESTOCK disposition.
 * @returns {{ lineId: string, quantity: number }[]}
 */
async function restockStandardLinesExplicit(lines, actor) {
  const actorUserId = await resolveActorUserId(actor);
  const restocked = [];

  await prisma.$transaction(async (tx) => {
    for (const sibling of lines) {
      if (sibling.restockedAt) continue;
      if (sibling.type && sibling.type !== 'STANDARD') continue;
      if (sibling.status !== 'APPROVED') {
        throw new AppError(400, `Line ${sibling.publicId} must be APPROVED before restock`);
      }
      const disposition = String(sibling.disposition || '').toUpperCase();
      if (disposition && disposition !== 'RESTOCK') {
        throw new AppError(400, `Line ${sibling.publicId} disposition is ${disposition}, not RESTOCK`);
      }
      const maxQty = lineAcceptedQty(sibling);
      if (maxQty <= 0) continue;
      if (!sibling.orderItem) {
        throw new AppError(400, `Line ${sibling.publicId} is missing order item data for restock`);
      }
      const product = await tx.product.findUnique({
        where: { id: sibling.orderItem.productId },
        include: { variants: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!product) {
        throw new AppError(400, `Product not found for line ${sibling.publicId}`);
      }
      await restockOrderLineStock(
        tx,
        product,
        sibling.orderItem.productVariantId,
        maxQty,
        {
          referenceType: 'return',
          referenceId: sibling.publicId,
          actorUserId,
          note: returnLedgerNote(
            'RESTOCK',
            sibling.returnNumber || sibling.publicId,
            sibling.type || 'STANDARD'
          ),
        },
        'RESTOCK'
      );
      await tx.returnRequest.update({
        where: { id: sibling.id },
        data: {
          restockedAt: new Date(),
          restockedQuantity: maxQty,
          disposition: sibling.disposition || 'RESTOCK',
          dispositionQuantity: maxQty,
        },
      });
      await appendReturnActionNote(tx, {
        returnRequestId: sibling.id,
        status: sibling.status,
        actorUserId,
        note: `Restocked ${maxQty} unit${maxQty === 1 ? '' : 's'} to inventory`,
      });
      restocked.push({ lineId: sibling.publicId, quantity: maxQty });
    }
  });

  return restocked;
}

function computeRefurbCreditPreview(row) {
  if (row?.type !== 'REFURBISHMENT' || !row.orderItem) return null;
  if (row.orderItem.product?.productType === 'REFURBISHED') return 0;
  const unit = Number(row.orderItem.memberPriceSnapshot ?? row.orderItem.price ?? 0);
  const qty =
    row.acceptedQuantity != null
      ? Math.max(0, Number(row.acceptedQuantity))
      : Math.max(1, Number(row.quantity ?? 1));
  return Math.round(computeRefurbStoreCredit(unit) * qty * 100) / 100;
}

/** Units available to inspect on a refurb line (received if tracked, else requested qty). */
function refurbInspectableQty(row) {
  const received = Math.max(0, Number(row.receivedQuantity ?? 0));
  if (received > 0) return received;
  return Math.max(1, Number(row.quantity ?? 1));
}

/** Admin refurb queue: keep returns visible from eligibility through inspection. */
function isRefurbVisibleToAdmin(row, openPackageOrderIds = new Set()) {
  if (row.type !== 'REFURBISHMENT') return true;
  // Always show while awaiting customer ship (even before tracking) and through warehouse stages.
  if (
    [
      'ELIGIBILITY_REVIEW',
      'APPROVED',
      'LABEL_GENERATED',
      'IN_TRANSIT',
      'RECEIVED',
      'UNDER_INSPECTION',
      'INSPECTION_APPROVED',
      'INSPECTION_REJECTED',
    ].includes(row.status)
  ) {
    return true;
  }
  if (row.customerShippingSubmittedAt || row.manualTrackingNumber) return true;
  if (openPackageOrderIds.has(row.orderId)) return true;
  return false;
}

async function loadOpenPackageOrderIds(orderIds = []) {
  if (!orderIds.length) return new Set();
  const rows = await prisma.returnPackageRequest.findMany({
    where: {
      orderId: { in: orderIds },
      status: { in: ['REQUESTED', 'APPROVED', 'SENT'] },
    },
    select: { orderId: true },
  });
  return new Set(rows.map((r) => r.orderId));
}

function buildSubmissionChildItem(row) {
  const customerNotes = row.customerNotes ?? row.notes ?? null;
  return {
    id: row.publicId,
    submissionId: returnSubmissionKey(row),
    returnNumber: row.returnNumber || null,
    type: row.type,
    status: row.status,
    quantity: row.quantity,
    receivedQuantity: Math.max(0, Number(row.receivedQuantity ?? 0)),
    remainingQuantity: Math.max(
      0,
      Math.max(1, Number(row.quantity ?? 1)) - Math.max(0, Number(row.receivedQuantity ?? 0))
    ),
    acceptedQuantity: row.acceptedQuantity ?? null,
    rejectedQuantity: row.rejectedQuantity ?? null,
    reason: row.reason,
    notes: customerNotes,
    customerNotes,
    adminNotes: row.adminNotes ?? null,
    rejectionReason: row.rejectionReason,
    photoUrlsJson: row.photoUrlsJson,
    inspectorPhotoUrlsJson: row.inspectorPhotoUrlsJson ?? null,
    inspectionChecklistJson: row.inspectionChecklistJson ?? null,
    disposition: row.disposition ?? null,
    dispositionQuantity: row.dispositionQuantity ?? null,
    rejectedDisposition: row.rejectedDisposition ?? null,
    creditAwarded: row.creditAwarded,
    refundAmount: row.refundAmount,
    stripeRefundId: row.stripeRefundId,
    refundedAt: row.refundedAt,
    refundPaymentMethodLabel: row.refundPaymentMethodLabel ?? null,
    refundPreview: row.refundPreview ?? computeRowRefundPreview(row),
    restockedAt: row.restockedAt ?? null,
    restockedQuantity: row.restockedQuantity ?? null,
    manualCarrier: row.manualCarrier,
    manualTrackingNumber: row.manualTrackingNumber,
    manualShippedAt: row.manualShippedAt,
    customerShippingNote: row.customerShippingNote ?? null,
    customerShippingPhotoUrl: row.customerShippingPhotoUrl ?? null,
    customerShippingSubmittedAt: row.customerShippingSubmittedAt ?? null,
    shipByDeadline: row.shipByDeadline ?? null,
    keepWaitingUntil: row.keepWaitingUntil ?? null,
    creditPreview: computeRefurbCreditPreview(row),
    returnLabelUrl: row.returnLabelUrl,
    returnTrackingNumber: row.returnTrackingNumber,
    returnShippingCarrier: row.returnShippingCarrier,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    user: row.user,
    order: row.order,
    orderItem: row.orderItem,
    eligibilityQuestionnaire: row.eligibilityQuestionnaire,
    inspectionRecords: row.inspectionRecords,
    refurbishmentJob: row.refurbishmentJob,
    statusEvents: row.statusEvents,
  };
}

function buildReturnSubmission(rows, { includeEvents = false } = {}) {
  if (!rows.length) return null;
  const ordered = [...rows].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const latestFirst = [...ordered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const primary = ordered[0];
  const submissionId = returnSubmissionKey(primary);
  const items = ordered.map((row) => buildSubmissionChildItem({ ...row, submissionId }));
  const refundAmounts = items.map((row) => Number(row.refundAmount ?? 0));
  const hasExplicitRefundAmount = items.some((row) => row.refundAmount != null);
  const refundPreview = items.reduce((sum, row) => sum + Number(row.refundPreview ?? 0), 0);
  const creditAwarded = items.reduce((sum, row) => sum + Number(row.creditAwarded ?? 0), 0);
  const quantity = items.reduce((sum, row) => sum + Math.max(1, Number(row.quantity ?? 1)), 0);
  const statusEvents = includeEvents ? buildSubmissionStatusEvents(items) : undefined;
  const latestTrackingRow = latestFirst.find((row) => row.returnTrackingNumber || row.manualTrackingNumber || row.returnLabelUrl);

  const refundedAts = items.map((row) => row.refundedAt).filter(Boolean);
  const latestRefundedAt =
    refundedAts.length > 0
      ? refundedAts.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
      : null;
  const refundPaymentMethodLabel =
    items.find((row) => row.refundPaymentMethodLabel)?.refundPaymentMethodLabel ?? null;

  const returnNumber =
    ordered.find((row) => row.returnNumber)?.returnNumber || primary.returnNumber || null;

  return {
    id: submissionId,
    submissionId,
    returnNumber,
    primaryItemId: primary.publicId,
    type: primary.type,
    status: deriveSubmissionStatus(items),
    reason: primary.reason,
    notes: primary.customerNotes ?? primary.notes,
    customerNotes: primary.customerNotes ?? primary.notes,
    adminNotes: items.length === 1 ? primary.adminNotes ?? null : null,
    rejectionReason: items.length === 1 ? primary.rejectionReason : null,
    createdAt: primary.createdAt,
    updatedAt: latestFirst[0]?.updatedAt ?? primary.updatedAt,
    quantity,
    photoUrlsJson:
      primary.type === 'STANDARD' && Array.isArray(primary.photoUrlsJson) ? primary.photoUrlsJson : null,
    creditAwarded,
    refundAmount: hasExplicitRefundAmount ? refundAmounts.reduce((sum, value) => sum + value, 0) : null,
    refundPreview: refundPreview > 0 ? refundPreview : null,
    stripeRefundId: items.length === 1 ? primary.stripeRefundId : null,
    refundedAt: latestRefundedAt,
    refundPaymentMethodLabel,
    manualCarrier: items.length === 1 ? primary.manualCarrier : latestTrackingRow?.manualCarrier ?? null,
    manualTrackingNumber:
      items.length === 1 ? primary.manualTrackingNumber : latestTrackingRow?.manualTrackingNumber ?? null,
    manualShippedAt: items.length === 1 ? primary.manualShippedAt : latestTrackingRow?.manualShippedAt ?? null,
    customerShippingNote: latestTrackingRow?.customerShippingNote ?? primary.customerShippingNote ?? null,
    customerShippingPhotoUrl:
      latestTrackingRow?.customerShippingPhotoUrl ?? primary.customerShippingPhotoUrl ?? null,
    customerShippingSubmittedAt:
      latestTrackingRow?.customerShippingSubmittedAt ?? primary.customerShippingSubmittedAt ?? null,
    shipByDeadline: primary.shipByDeadline ?? latestFirst.find((r) => r.shipByDeadline)?.shipByDeadline ?? null,
    keepWaitingUntil: primary.keepWaitingUntil ?? latestFirst.find((r) => r.keepWaitingUntil)?.keepWaitingUntil ?? null,
    creditPreview: items.reduce((sum, row) => sum + Number(row.creditPreview ?? 0), 0) || null,
    returnLabelUrl: latestTrackingRow?.returnLabelUrl ?? null,
    returnTrackingNumber: latestTrackingRow?.returnTrackingNumber ?? null,
    returnShippingCarrier: latestTrackingRow?.returnShippingCarrier ?? null,
    eligibilityQuestionnaire: items.length === 1 ? primary.eligibilityQuestionnaire : null,
    inspectionRecords: items.length === 1 ? primary.inspectionRecords : [],
    refurbishmentJob: items.length === 1 ? primary.refurbishmentJob : null,
    user: primary.user,
    order: primary.order,
    orderItem: items.length === 1 ? primary.orderItem : null,
    items,
    statusEvents,
  };
}

function groupReturnRows(rows, { includeEvents = false } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = returnSubmissionKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()]
    .map((group) => buildReturnSubmission(group, { includeEvents }))
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export class ReturnsService {
  validateTransition(current, next, type = 'STANDARD') {
    const map = type === 'REFURBISHMENT' ? REFURB_TRANSITIONS : STANDARD_TRANSITIONS;
    return (map[current] || []).includes(next);
  }

  /**
   * Admin return list. SCALE-001: filters/search/pagination run in the DB;
   * when `limit` is set, never materializes the full dataset before paging.
   * Omitting `limit` keeps the legacy unpaginated array response for callers
   * that have not yet migrated (prefer always passing page+limit from admin UI).
   */
  async listAll(filters = {}) {
    const where = buildAdminReturnListWhere(filters);
    const { page, limit, skip, paginate } = normalizeAdminListPagination(filters);
    const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];

    if (filters.grouped) {
      if (!paginate) {
        const rows = await prisma.returnRequest.findMany({
          where,
          include: returnListInclude,
          orderBy,
          take: limit,
        });
        return groupReturnRows(rows);
      }

      const [pageGroups, allGroups] = await Promise.all([
        prisma.returnRequest.groupBy({
          by: ['submissionPublicId'],
          where,
          _max: { createdAt: true },
          orderBy: [{ _max: { createdAt: 'desc' } }, { submissionPublicId: 'desc' }],
          skip,
          take: limit,
        }),
        prisma.returnRequest.groupBy({
          by: ['submissionPublicId'],
          where,
        }),
      ]);

      const total = allGroups.length;
      const pages = Math.max(1, Math.ceil(total / limit) || 1);
      const submissionIds = pageGroups.map((g) => g.submissionPublicId).filter(Boolean);

      if (submissionIds.length === 0) {
        return { items: [], pagination: { total, page, limit, pages } };
      }

      const rows = await prisma.returnRequest.findMany({
        where: {
          AND: [where, { submissionPublicId: { in: submissionIds } }],
        },
        include: returnListInclude,
        orderBy,
      });

      const grouped = groupReturnRows(rows);
      const rank = new Map(submissionIds.map((id, idx) => [id, idx]));
      grouped.sort((a, b) => {
        const ra = rank.get(a.submissionId) ?? rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b.submissionId) ?? rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ra - rb;
      });

      return {
        items: grouped,
        pagination: { total, page, limit, pages },
      };
    }

    if (!paginate) {
      return prisma.returnRequest.findMany({
        where,
        include: returnListInclude,
        orderBy,
        take: limit,
      });
    }

    const [rows, total] = await Promise.all([
      prisma.returnRequest.findMany({
        where,
        include: returnListInclude,
        orderBy,
        skip,
        take: limit,
      }),
      prisma.returnRequest.count({ where }),
    ]);

    const pages = Math.max(1, Math.ceil(total / limit) || 1);
    return {
      items: rows,
      pagination: { total, page, limit, pages },
    };
  }

  /** Lightweight counts for Returns / Inspection mini-stats and header alerts. */
  async getAdminListStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const pendingStandardWhere = buildAdminReturnListWhere({
      type: 'STANDARD',
      statuses: ['REQUESTED', 'RECEIVED', 'UNDER_INSPECTION'],
    });
    const refurbWhere = buildAdminReturnListWhere({ type: 'REFURBISHMENT' });
    const adminVisibleWhere = buildAdminReturnListWhere({
      type: 'REFURBISHMENT',
      adminVisible: true,
    });
    const inspectionTodayWhere = {
      AND: [
        buildAdminReturnListWhere({ status: 'UNDER_INSPECTION' }),
        { createdAt: { gte: todayStart } },
      ],
    };

    const [
      pendingStandardGroups,
      refurbGroups,
      adminVisibleGroups,
      eligibilityGroups,
      awaitingGroups,
      transitGroups,
      physicalGroups,
      packageRequested,
      inspectionToday,
    ] = await Promise.all([
      prisma.returnRequest.groupBy({ by: ['submissionPublicId'], where: pendingStandardWhere }),
      prisma.returnRequest.groupBy({ by: ['submissionPublicId'], where: refurbWhere }),
      prisma.returnRequest.groupBy({ by: ['submissionPublicId'], where: adminVisibleWhere }),
      prisma.returnRequest.groupBy({
        by: ['submissionPublicId'],
        where: buildAdminReturnListWhere({
          type: 'REFURBISHMENT',
          adminVisible: true,
          status: 'ELIGIBILITY_REVIEW',
        }),
      }),
      prisma.returnRequest.groupBy({
        by: ['submissionPublicId'],
        where: buildAdminReturnListWhere({
          type: 'REFURBISHMENT',
          adminVisible: true,
          statuses: ['APPROVED', 'LABEL_GENERATED'],
        }),
      }),
      prisma.returnRequest.groupBy({
        by: ['submissionPublicId'],
        where: buildAdminReturnListWhere({
          type: 'REFURBISHMENT',
          adminVisible: true,
          status: 'IN_TRANSIT',
        }),
      }),
      prisma.returnRequest.groupBy({
        by: ['submissionPublicId'],
        where: buildAdminReturnListWhere({
          type: 'REFURBISHMENT',
          adminVisible: true,
          status: 'UNDER_INSPECTION',
        }),
      }),
      prisma.returnPackageRequest.count({ where: { status: 'REQUESTED' } }),
      prisma.returnRequest.count({ where: inspectionTodayWhere }),
    ]);

    return {
      pendingStandard: pendingStandardGroups.length,
      refurbishmentTotal: refurbGroups.length,
      packageRequested,
      inspectionToday,
      inspectionQueues: {
        eligibility: eligibilityGroups.length,
        awaiting: awaitingGroups.length,
        transit: transitGroups.length,
        physical: physicalGroups.length,
        adminVisibleTotal: adminVisibleGroups.length,
      },
    };
  }

  async listForUser(userPublicId) {
    const user = await prisma.user.findUnique({ where: { publicId: userPublicId }, select: { id: true } });
    if (!user) throw new AppError(401, 'Unauthorized');
    const rows = await prisma.returnRequest.findMany({
      where: { userId: user.id },
      include: returnInclude,
      orderBy: { createdAt: 'desc' },
    });
    return groupReturnRows(rows);
  }

  async getForUser(userPublicId, returnPublicId) {
    const user = await prisma.user.findUnique({ where: { publicId: userPublicId }, select: { id: true } });
    if (!user) throw new AppError(401, 'Unauthorized');
    let rows = await prisma.returnRequest.findMany({
      where: {
        userId: user.id,
        OR: [
          { publicId: returnPublicId },
          { submissionPublicId: returnPublicId },
          { returnNumber: returnPublicId },
        ],
      },
      include: returnInclude,
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 1) {
      const key = returnSubmissionKey(rows[0]);
      if (key && key !== returnPublicId) {
        rows = await prisma.returnRequest.findMany({
          where: { userId: user.id, submissionPublicId: key },
          include: returnInclude,
          orderBy: { createdAt: 'asc' },
        });
      }
    }
    if (!rows.length) throw new AppError(404, 'Return request not found');
    const rowsWithEvents = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        refundPreview: computeRowRefundPreview(row),
        statusEvents: await listReturnStatusEvents(row.id),
      }))
    );
    const submission = buildReturnSubmission(rowsWithEvents, { includeEvents: true });
    const packageRequest = await this.getPackageRequestForSubmission(rows);
    return { ...submission, packageRequest };
  }

  async getById(returnPublicId) {
    const row = await resolveReturnRequestRow(returnPublicId);
    if (!row) throw new AppError(404, 'Return request not found', 'RETURN_NOT_FOUND');
    const submissionKey = returnSubmissionKey(row);
    const submissionItems = await prisma.returnRequest.findMany({
      where: { submissionPublicId: submissionKey },
      include: returnInclude,
      orderBy: { createdAt: 'asc' },
    });
    const rowsWithEvents = await Promise.all(
      submissionItems.map(async (item) => ({
        ...item,
        refundPreview: computeRowRefundPreview(item),
        statusEvents: await listReturnStatusEvents(item.id),
      }))
    );
    const statusEvents = buildSubmissionStatusEvents(rowsWithEvents);
    const submissionRefundPreview = submissionItems.reduce(
      (sum, item) => sum + Number(computeRowRefundPreview(item) || 0),
      0
    );
    const submissionReturnNumber =
      submissionItems.find((item) => item.returnNumber)?.returnNumber || row.returnNumber || null;
    const rowsWithPreview = rowsWithEvents.map(({ statusEvents: _events, ...item }) => item);
    const submission = buildReturnSubmission(rowsWithPreview, { includeEvents: false });
    const packageRequest = await this.getPackageRequestForSubmission(submissionItems);
    const receivePackages = await this.listReceivePackages(submissionKey);
    const receivedQuantityTotal = submissionItems.reduce(
      (sum, item) => sum + Math.max(0, Number(item.receivedQuantity ?? 0)),
      0
    );
    const remainingQuantityTotal = submissionItems.reduce((sum, item) => {
      const requested = Math.max(1, Number(item.quantity ?? 1));
      const received = Math.max(0, Number(item.receivedQuantity ?? 0));
      return sum + Math.max(0, requested - received);
    }, 0);
    const primary = submissionItems[0] || row;
  return {
      ...submission,
      // Keep list/detail URL stable on the shared submission id (not a single line publicId).
      id: submissionKey,
      primaryItemId: primary.publicId,
      statusEvents,
      returnNumber: submissionReturnNumber,
      submissionId: submissionKey,
      submissionPublicId: submissionKey,
      refundPreview: submissionRefundPreview > 0 ? submissionRefundPreview : submission?.refundPreview ?? null,
      submissionItems: rowsWithPreview.map((item) =>
        buildSubmissionChildItem(item)
      ),
      submissionStatus: deriveSubmissionStatus(submissionItems),
      submissionQuantity: submissionItems.reduce((sum, item) => sum + Math.max(1, Number(item.quantity ?? 1)), 0),
      receivedQuantity: receivedQuantityTotal,
      remainingQuantity: remainingQuantityTotal,
      receivePackages,
      refundAmount: submissionItems.some((i) => i.refundAmount != null)
        ? submissionItems.reduce((sum, i) => sum + Number(i.refundAmount || 0), 0)
        : row.refundAmount,
      refundedAt: submissionItems.map((i) => i.refundedAt).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || row.refundedAt,
      refundPaymentMethodLabel:
        submissionItems.find((i) => i.refundPaymentMethodLabel)?.refundPaymentMethodLabel ||
        row.refundPaymentMethodLabel,
      packageRequest,
      eligibilityQuestionnaire:
        submissionItems.length === 1 ? primary.eligibilityQuestionnaire : row.eligibilityQuestionnaire,
      inspectionRecords: submissionItems.length === 1 ? primary.inspectionRecords : row.inspectionRecords,
      refurbishmentJob: submissionItems.length === 1 ? primary.refurbishmentJob : row.refurbishmentJob,
      user: primary.user || row.user,
      order: primary.order || row.order,
      orderItem: submissionItems.length === 1 ? primary.orderItem : null,
      type: primary.type || row.type,
      status: deriveSubmissionStatus(submissionItems),
      reason: primary.reason ?? row.reason,
      notes: primary.customerNotes ?? primary.notes ?? row.customerNotes ?? row.notes,
      customerNotes: primary.customerNotes ?? primary.notes ?? row.customerNotes ?? row.notes,
      adminNotes: submissionItems.length === 1 ? primary.adminNotes ?? null : null,
      inspectionChecklistJson: primary.inspectionChecklistJson ?? row.inspectionChecklistJson ?? null,
      createdAt: primary.createdAt || row.createdAt,
      updatedAt: primary.updatedAt || row.updatedAt,
    };
  }

  async trackGuestReturn({ returnId, email }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) throw new AppError(400, 'Email is required');
    let rows = await prisma.returnRequest.findMany({
      where: {
        OR: [{ publicId: returnId }, { submissionPublicId: returnId }, { returnNumber: returnId }],
      },
      include: {
        ...returnInclude,
        user: { select: { email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 1) {
      const key = returnSubmissionKey(rows[0]);
      if (key && key !== returnId) {
        rows = await prisma.returnRequest.findMany({
          where: { submissionPublicId: key },
          include: {
            ...returnInclude,
            user: { select: { email: true } },
          },
          orderBy: { createdAt: 'asc' },
        });
      }
    }
    if (!rows.length || String(rows[0].user?.email || '').toLowerCase() !== normalizedEmail) {
      throw new AppError(404, 'Return not found');
    }
    const rowsWithEvents = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        refundPreview: computeRowRefundPreview(row),
        statusEvents: await listReturnStatusEvents(row.id),
      }))
    );
    return buildReturnSubmission(rowsWithEvents, { includeEvents: true });
  }

  resolveOrderItemIds(payload, order) {
    if (payload.orderItemIds?.length) return payload.orderItemIds;
    if (payload.orderItemId) return [payload.orderItemId];
    const first = order.orderItems[0]?.publicId;
    return first ? [first] : [];
  }

  async createForUser(userPublicId, payload) {
    const user = await prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true, accessMemberUntil: true },
    });
    if (!user) throw new AppError(401, 'Unauthorized');

    const order = await prisma.order.findUnique({
      where: { publicId: payload.orderId },
      include: { orderItems: { include: { product: true } } },
    });
    if (!order || order.userId !== user.id) throw new AppError(404, 'Order not found');

    const refurbItems =
      payload.type === 'REFURBISHMENT'
        ? Array.isArray(payload.refurbItems) && payload.refurbItems.length > 0
          ? payload.refurbItems
          : [
              {
                orderItemId: payload.orderItemIds?.[0] || payload.orderItemId,
                quantity: payload.quantity ?? 1,
                questionnaire: payload.questionnaire,
                photoUrls: payload.photoUrls,
              },
            ].filter((item) => item.orderItemId)
        : [];
    const itemPublicIds =
      payload.type === 'REFURBISHMENT'
        ? refurbItems.map((item) => item.orderItemId)
        : this.resolveOrderItemIds(payload, order);
    if (itemPublicIds.length === 0) throw new AppError(404, 'Order item not found');
    if (new Set(itemPublicIds).size !== itemPublicIds.length) {
      throw new AppError(400, 'Each item can only be selected once per return request');
    }
    const refurbItemById = new Map(refurbItems.map((item) => [item.orderItemId, item]));

    const returnType = payload.type || 'STANDARD';
    for (const publicId of itemPublicIds) {
      const targetItem = order.orderItems.find((i) => i.publicId === publicId);
      if (!targetItem) throw new AppError(404, 'Order item not found');
      if (targetItem.cancelledAt) {
        throw new AppError(
          400,
          'Cancelled order items cannot be returned',
          'ORDER_ITEM_CANCELLED',
          { orderItemId: publicId }
        );
      }
      // BR-001: product-condition eligibility is line-scoped; any ineligible line fails the request.
      assertOrderLineEligibleForReturnType({
        returnType,
        productType: targetItem.product?.productType,
      });
    }

    if (payload.type === 'REFURBISHMENT') {
      const { isRefurbishedEnabled } = await import('../config/feature-flags.js');
      if (!isRefurbishedEnabled()) {
        throw new AppError(403, 'Refurbishment returns are not available yet');
      }
      const hasAccess = Boolean(user.accessMemberUntil && user.accessMemberUntil > new Date());
      if (!hasAccess) throw new AppError(403, 'Farmhouse Friends required for refurbishment returns');
      const windowStart = resolveUsedReturnWindowStart(order);
      if (!windowStart) {
        throw new AppError(400, 'Return Used Product becomes available after delivery');
      }
      const windowDays = await getAccessUsedReturnWindowDays();
      const usedAgeDays = (Date.now() - windowStart.getTime()) / (1000 * 60 * 60 * 24);
      if (usedAgeDays > windowDays) {
        throw new AppError(400, `Used return window (${windowDays} days from delivery) has passed`);
      }
    }

    if (payload.type === 'STANDARD') {
      const reasonMap =
        payload.reasons && typeof payload.reasons === 'object' ? payload.reasons : {};
      const fallbackReason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
      const missingReason = itemPublicIds.find((id) => {
        const fromMap = typeof reasonMap[id] === 'string' ? reasonMap[id].trim() : '';
        return !fromMap && !fallbackReason;
      });
      if (missingReason) {
        throw new AppError(400, 'Select a return reason for each selected item');
      }
      if (!resolveStandardReturnWindowStart(order)) {
        throw new AppError(400, 'Standard returns become available after delivery');
      }
      if (standardReturnWindowDaysLeft(order) <= 0) {
        throw new AppError(400, 'Standard return window (30 days from delivery) has passed');
      }
    }

    const existing = await prisma.returnRequest.findMany({
      where: {
        orderId: order.id,
        orderItem: { publicId: { in: itemPublicIds } },
        status: { notIn: [...TERMINAL_RETURN_REJECT_STATUSES] },
      },
      select: {
        publicId: true,
        submissionPublicId: true,
        status: true,
        type: true,
        quantity: true,
        orderItem: { select: { publicId: true, quantity: true } },
      },
    });

    const existingByItemId = new Map();
    for (const row of existing) {
      const itemId = row.orderItem?.publicId;
      if (!itemId) continue;
      if (!existingByItemId.has(itemId)) existingByItemId.set(itemId, []);
      existingByItemId.get(itemId).push(row);
    }

    const insufficient = [];
    const pendingIds = [];
    for (const publicId of itemPublicIds) {
      const orderItem = order.orderItems.find((i) => i.publicId === publicId);
      if (!orderItem) continue;
      const lineReturns = existingByItemId.get(publicId) ?? [];

      const returnable = returnableQuantityForLine({
        quantity: orderItem.quantity,
        cancelledAt: orderItem.cancelledAt,
        returnRequests: lineReturns,
      });
      const requestedQty =
        payload.type === 'REFURBISHMENT'
          ? Number(refurbItemById.get(publicId)?.quantity ?? 1)
          : Number(payload.quantities?.[publicId] ?? payload.quantity ?? 1);
      const qty = Math.max(1, Number.isFinite(requestedQty) ? requestedQty : 1);

      if (orderItem.cancelledAt || returnable <= 0) {
        insufficient.push({ orderItemId: publicId, openReturns: lineReturns });
        continue;
      }
      if (qty > returnable) {
        throw new AppError(
          400,
          `You can return at most ${returnable} unit${returnable === 1 ? '' : 's'} for this line item`,
          'RETURN_QUANTITY_EXCEEDED',
          { orderItemId: publicId, returnable, requested: qty }
        );
      }
      pendingIds.push(publicId);
    }

    // Do not silently create a subset when the customer selected multiple lines.
    if (insufficient.length > 0 && pendingIds.length > 0) {
      throw new AppError(
        400,
        'One or more selected items cannot be returned (already returned or open return). Remove them and try again.',
        'RETURN_PARTIAL_SELECTION',
        {
          orderId: order.publicId,
          failedOrderItemIds: insufficient.map((e) => e.orderItemId),
          existingReturns: insufficient.flatMap((entry) =>
            entry.openReturns.map((r) => ({
              returnId: r.returnNumber || r.submissionPublicId || r.publicId,
              status: r.status,
              type: r.type,
              orderItemId: r.orderItem?.publicId,
            }))
          ),
        }
      );
    }

    if (pendingIds.length === 0) {
      const flatExisting = insufficient.flatMap((entry) => entry.openReturns);
      const summary = flatExisting
        .map((r) => `${r.orderItem?.publicId}: ${r.status} (${r.publicId})`)
        .join(', ');
      throw new AppError(
        409,
        'Selected items on this order already have an open return request',
        'RETURN_ALREADY_OPEN',
        {
          orderId: order.publicId,
          orderNumber: order.orderNumber,
          existingReturns: flatExisting.map((r) => ({
            returnId: r.returnNumber || r.submissionPublicId || r.publicId,
            returnNumber: r.returnNumber || null,
            status: r.status,
            type: r.type,
            orderItemId: r.orderItem?.publicId,
            orderId: order.publicId,
            orderNumber: order.orderNumber,
          })),
          summary,
        }
      );
    }

    const eligibilityByItemId = new Map();
    if (payload.type === 'REFURBISHMENT') {
      for (const item of refurbItems) {
        eligibilityByItemId.set(item.orderItemId, evaluateRefurbQuestionnaire(item.questionnaire, item.photoUrls));
      }
    }

    const created = [];
    let submissionPublicId = null;
    for (const publicId of pendingIds) {
      const orderItem = order.orderItems.find((i) => i.publicId === publicId);
      if (!orderItem) throw new AppError(404, 'Order item not found');
      const refurbItem = refurbItemById.get(publicId);
      const eligibilityEval = payload.type === 'REFURBISHMENT' ? eligibilityByItemId.get(publicId) : null;

      const initialStatus =
        payload.type === 'REFURBISHMENT' && eligibilityEval
          ? initialReturnStatusForDecision(eligibilityEval.decision)
          : 'REQUESTED';

      const requestedQty =
        payload.type === 'REFURBISHMENT'
          ? Number(refurbItem?.quantity ?? 1)
          : Number(payload.quantities?.[publicId] ?? payload.quantity ?? 1);
      const requestedUnits = Math.max(1, Number.isFinite(requestedQty) ? requestedQty : 1);

      const reasonMap =
        payload.reasons && typeof payload.reasons === 'object' ? payload.reasons : {};
      const lineReason =
        (typeof reasonMap[publicId] === 'string' ? reasonMap[publicId].trim() : '') ||
        (typeof payload.reason === 'string' ? payload.reason.trim() : '') ||
        null;

      const notesMap =
        payload.notesByItem && typeof payload.notesByItem === 'object' ? payload.notesByItem : {};
      const itemNotes =
        typeof notesMap[publicId] === 'string' ? String(notesMap[publicId]).trim() : '';
      const sharedNotes = payload.notes ? String(payload.notes).trim() : '';
      const lineNotes =
        [itemNotes, sharedNotes].filter(Boolean).join('\n\n') || null;

      const photosMap =
        payload.photoUrlsByItem && typeof payload.photoUrlsByItem === 'object'
          ? payload.photoUrlsByItem
          : {};
      const itemPhotos = Array.isArray(photosMap[publicId]) ? photosMap[publicId] : null;
      const linePhotos =
        payload.type === 'STANDARD'
          ? itemPhotos?.length
            ? itemPhotos
            : payload.photoUrls || undefined
          : undefined;

      // WS-A5: lock OrderItem, recalculate returnable, then create — prevents concurrent over-claim.
      const row = await prisma.$transaction(async (tx) => {
        const lockedRows = await tx.$queryRaw`
          SELECT id, "publicId", quantity, "cancelledAt"
          FROM "OrderItem"
          WHERE id = ${orderItem.id}
          FOR UPDATE
        `;
        const locked = lockedRows?.[0];
        if (!locked) throw new AppError(404, 'Order item not found');
        if (locked.cancelledAt) {
          throw new AppError(
            400,
            'Cancelled order items cannot be returned',
            'ORDER_ITEM_CANCELLED',
            { orderItemId: publicId }
          );
        }

        const lineReturns = await tx.returnRequest.findMany({
          where: {
            orderItemId: locked.id,
            status: { notIn: [...TERMINAL_RETURN_REJECT_STATUSES] },
          },
          select: { status: true, quantity: true },
        });

        const returnable = returnableQuantityForLine({
          quantity: locked.quantity,
          cancelledAt: locked.cancelledAt,
          returnRequests: lineReturns,
        });
        const quantity = Math.min(
          Math.max(1, Number(locked.quantity) || 1),
          requestedUnits
        );
        if (returnable <= 0) {
          throw new AppError(
            409,
            'Selected items on this order already have an open return request',
            'RETURN_ALREADY_OPEN',
            { orderItemId: publicId, returnable: 0, requested: quantity }
          );
        }
        if (quantity > returnable) {
          throw new AppError(
            400,
            `You can return at most ${returnable} unit${returnable === 1 ? '' : 's'} for this line item`,
            'RETURN_QUANTITY_EXCEEDED',
            { orderItemId: publicId, returnable, requested: quantity }
          );
        }

        const rr = await tx.returnRequest.create({
          data: {
            ...(submissionPublicId ? { submissionPublicId } : {}),
            userId: user.id,
            orderId: order.id,
            orderItemId: locked.id,
            type: payload.type,
            reason: lineReason,
            notes: lineNotes,
            customerNotes: lineNotes,
            photoUrlsJson: linePhotos,
            status: initialStatus,
            quantity,
          },
        });

        // First line: pin submissionPublicId to this line's publicId so list/detail
        // URLs match a real ReturnRequest publicId (Prisma default cuid differs).
        if (!submissionPublicId) {
          submissionPublicId = rr.publicId;
          await tx.returnRequest.update({
            where: { id: rr.id },
            data: { submissionPublicId },
          });
          await assignReturnNumber(tx, rr.id, payload.type);
        }

        await appendReturnStatusEvent(tx, {
          returnRequestId: rr.id,
          fromStatus: null,
          toStatus: initialStatus,
          note: 'Return submitted',
        });

        if (payload.type === 'REFURBISHMENT' && eligibilityEval) {
          await tx.returnEligibilityQuestionnaire.create({
            data: {
              returnRequestId: rr.id,
              answersJson: refurbItem?.questionnaire,
              photoUrlsJson: refurbItem?.photoUrls ?? {},
              autoDecision: eligibilityEval.decision,
              autoDecisionReasons: eligibilityEval.reasons,
            },
          });
        }

        return tx.returnRequest.findUnique({
          where: { id: rr.id },
          include: returnInclude,
        });
      });

      created.push(row);
    }

    const primaryRow = created[0];
    if (primaryRow) {
      try {
        if (created.some((row) => row.status === 'ELIGIBILITY_REVIEW')) {
          notifyEligibilityReview(primaryRow);
        } else {
          notifyReturnRequest(primaryRow);
        }
      } catch (err) {
        console.error('[returns] admin notification failed', primaryRow.publicId, err);
      }
      if (primaryRow.user?.email) {
        try {
          await emailService.sendTemplate({
            to: primaryRow.user.email,
            template: 'return-requested',
            context: {
              name: [primaryRow.user.firstName, primaryRow.user.lastName].filter(Boolean).join(' '),
              returnType: payload.type === 'REFURBISHMENT' ? 'Used product return' : 'Standard return',
              returnNumber: primaryRow.returnNumber || null,
              actionUrl: `${config.frontend.customerUrl}/dashboard/returns/${submissionPublicId || primaryRow.publicId}`,
            },
          });
        } catch (err) {
          console.error('[returns] customer return-requested email failed', primaryRow.publicId, err);
        }
      }
    }

    return buildReturnSubmission(created);
  }

  /**
   * Guest self-service return: validate Order number + email (or a tracking token),
   * then create a STANDARD return on the matched order. UPS only; the one-envelope
   * rule applies when an admin issues the label.
   */
  async createForGuest(payload) {
    let orderNumber = payload.orderNumber ? String(payload.orderNumber).trim() : '';
    let email = payload.email ? String(payload.email).trim().toLowerCase() : '';

    if (payload.token) {
      const verified = verifyOrderTrackingToken(payload.token);
      orderNumber = verified.orderNumber;
      email = verified.email;
    }

    if (!orderNumber || !email) {
      throw new AppError(400, 'Order number and email are required');
    }

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ orderNumber }, { publicId: orderNumber }],
        contactEmail: { equals: email, mode: 'insensitive' },
      },
      select: { publicId: true, user: { select: { publicId: true } } },
    });
    if (!order || !order.user) {
      throw new AppError(404, 'Order not found for that email');
    }

    return this.createForUser(order.user.publicId, {
      orderId: order.publicId,
      orderItemId: payload.orderItemId,
      orderItemIds: payload.orderItemIds,
      type: 'STANDARD',
      reason: payload.reason,
    });
  }

  async reviewEligibility(returnPublicId, { decision, notes, lineIds }, actor) {
    let rr = await prisma.returnRequest.findUnique({
      where: { publicId: returnPublicId },
      include: {
        eligibilityQuestionnaire: true,
        user: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    if (!rr) {
      rr = await prisma.returnRequest.findFirst({
        where: {
          OR: [{ submissionPublicId: returnPublicId }, { returnNumber: returnPublicId }],
        },
        include: {
          eligibilityQuestionnaire: true,
          user: { select: { email: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!rr) throw new AppError(404, 'Return request not found');
    if (rr.type !== 'REFURBISHMENT') throw new AppError(400, 'Not a refurbishment return');

    const submissionKey = returnSubmissionKey(rr);
    const siblings = await prisma.returnRequest.findMany({
      where: { submissionPublicId: submissionKey, type: 'REFURBISHMENT' },
      include: {
        eligibilityQuestionnaire: true,
        user: { select: { email: true, firstName: true, lastName: true } },
        orderItem: { include: { product: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const requestedLineIds = Array.isArray(lineIds)
      ? lineIds.map((id) => String(id).trim()).filter(Boolean)
      : null;

    let targets = siblings.filter((s) => s.status === 'ELIGIBILITY_REVIEW');
    if (requestedLineIds?.length) {
      targets = targets.filter(
        (s) =>
          requestedLineIds.includes(s.publicId) ||
          requestedLineIds.includes(String(s.id))
      );
    }
    // If caller passed a specific line that is still pending, prefer that when no lineIds list.
    if (!requestedLineIds?.length && rr.status === 'ELIGIBILITY_REVIEW' && targets.length > 1) {
      // Default admin CTA: apply to all pending eligibility lines in the submission.
    }

    if (!targets.length) {
      throw new AppError(400, 'Return is not awaiting eligibility review');
    }

    if (decision !== 'approve' && decision !== 'reject') {
      throw new AppError(400, 'Decision must be approve or reject');
    }
    if (decision === 'reject' && !String(notes || '').trim()) {
      throw new AppError(400, 'A rejection reason is required');
    }

    const nextStatus = decision === 'approve' ? 'APPROVED' : 'ELIGIBILITY_REJECTED';
    const reviewerId = await resolveActorUserId(actor);
    const noteText = notes ? String(notes).trim() : `Eligibility ${decision}`;

    await prisma.$transaction(async (tx) => {
      for (const line of targets) {
        if (line.eligibilityQuestionnaire) {
          await tx.returnEligibilityQuestionnaire.update({
            where: { id: line.eligibilityQuestionnaire.id },
            data: {
              reviewedByUserId: reviewerId,
              reviewedAt: new Date(),
              reviewNotes: notes ? String(notes).trim() : null,
            },
          });
        }
        await tx.returnRequest.update({
          where: { id: line.id },
          data: {
            status: nextStatus,
            notes: notes !== undefined ? (notes ? String(notes).trim() : null) : undefined,
          },
        });
        await appendReturnStatusEvent(tx, {
          returnRequestId: line.id,
          fromStatus: line.status,
          toStatus: nextStatus,
          actorUserId: reviewerId,
          note: noteText,
        });
      }
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'RETURN_ELIGIBILITY_REVIEW',
      entityType: 'ReturnRequest',
      entityId: returnPublicId,
      meta: {
        decision,
        to: nextStatus,
        lineIds: targets.map((t) => t.publicId),
        submissionPublicId: submissionKey,
      },
    });

    if (rr.user?.email) {
      await emailService.sendTemplate({
        to: rr.user.email,
        template: 'return-status',
        context: {
          name: [rr.user.firstName, rr.user.lastName].filter(Boolean).join(' '),
          status: nextStatus,
          returnType: 'REFURBISHMENT',
          note:
            targets.length > 1
              ? `${targets.length} items: eligibility ${decision}`
              : undefined,
          actionUrl: `${config.frontend.customerUrl}/dashboard/returns/${submissionKey}`,
        },
      });
    }

    return this.getById(submissionKey);
  }

  async generateReturnLabel(returnPublicId, payload, actor) {
    const rr = await resolveReturnRequestRow(returnPublicId, {
      include: {
        order: { select: { id: true, shippingAddressJson: true, returnEnvelopeUsed: true } },
        user: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    if (!rr) throw new AppError(404, 'Return request not found', 'RETURN_NOT_FOUND');
    if (rr.type === 'REFURBISHMENT') {
      throw new AppError(
        400,
        'Refurbishment returns use customer-provided UPS tracking. Generate labels are not used for this path.'
      );
    }
    if (!['APPROVED', 'LABEL_GENERATED'].includes(rr.status)) {
      throw new AppError(400, 'Return must be approved before generating a label');
    }

    // One prepaid return envelope per order. The first return (of any type) gets a
    // prepaid UPS label; later returns on the same order require self-postage.
    if (rr.order.returnEnvelopeUsed && !rr.returnLabelUrl) {
      return { return: rr, label: null, selfPostageRequired: true };
    }

    const fromAddress = rr.order.shippingAddressJson;
    if (!fromAddress) throw new AppError(400, 'Order has no shipping address for return label');

    const label = useDemoReturnLabels()
      ? buildDemoReturnLabel(returnPublicId)
      : await shippingService.generateLabel({
          ...payload,
          fromAddress,
          toAddress: shippingService.getConfiguredOriginAddress(),
        });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: rr.order.id },
        data: { returnEnvelopeUsed: true },
      });
      const row = await tx.returnRequest.update({
        where: { id: rr.id },
        data: {
          status: 'LABEL_GENERATED',
          returnLabelUrl: label.shippingLabelUrl || rr.returnLabelUrl,
          returnTrackingNumber: label.trackingNumber || rr.returnTrackingNumber,
          returnShippingCarrier: label.shippingCarrier || rr.returnShippingCarrier,
          returnShipmentId: payload?.shipmentId ? String(payload.shipmentId) : rr.returnShipmentId,
          returnTransactionId: label.transactionId || rr.returnTransactionId,
          labelGeneratedAt: new Date(),
        },
        include: returnInclude,
      });
      const actorUserId = await resolveActorUserId(actor);
      await appendReturnStatusEvent(tx, {
        returnRequestId: rr.id,
        fromStatus: rr.status,
        toStatus: 'LABEL_GENERATED',
        actorUserId,
        note: label.trackingNumber ? `Label generated · ${label.trackingNumber}` : 'Return label generated',
      });
      return row;
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'RETURN_LABEL_GENERATED',
      entityType: 'ReturnRequest',
      entityId: returnPublicId,
      meta: {
        trackingNumber: updated.returnTrackingNumber,
        demo: useDemoReturnLabels(),
      },
    });

    return { return: updated, label };
  }

  resolveReturnStatusFromTracking(trackingStatus, currentStatus) {
    const statusUp = String(trackingStatus || '').toUpperCase();
    if (
      statusUp.includes('DELIVERED') ||
      statusUp.includes('DELIVERY') ||
      statusUp.includes('PICKED UP')
    ) {
      return 'RECEIVED';
    }
    if (
      statusUp.includes('TRANSIT') ||
      statusUp.includes('DEPART') ||
      statusUp.includes('ARRIVAL') ||
      statusUp.includes('SCAN') ||
      statusUp.includes('OUT FOR')
    ) {
      return currentStatus === 'RECEIVED' ? 'RECEIVED' : 'IN_TRANSIT';
    }
    return null;
  }

  async syncReturnTracking(returnPublicId) {
    const rr = await prisma.returnRequest.findUnique({
      where: { publicId: returnPublicId },
      include: returnInclude,
    });
    if (!rr?.returnTrackingNumber) return rr;
    if (!['LABEL_GENERATED', 'IN_TRANSIT'].includes(rr.status)) return rr;

    if (isDemoReturnTracking(rr.returnTrackingNumber, rr.returnShippingCarrier)) {
      const nextStatus = demoTrackingNextStatus(rr.status);
      if (!nextStatus || !this.validateTransition(rr.status, nextStatus, rr.type)) return rr;

      const data = { status: nextStatus };
      if (nextStatus === 'RECEIVED') data.receivedAt = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.returnRequest.update({
          where: { id: rr.id },
          data,
          include: returnInclude,
        });
        await appendReturnStatusEvent(tx, {
          returnRequestId: rr.id,
          fromStatus: rr.status,
          toStatus: nextStatus,
          note: `Tracking sync (demo) · ${nextStatus}`,
        });
        if (nextStatus === 'RECEIVED') {
          await markUnitsReturnedForReturn(tx, rr.id);
        }
        return row;
      });

      return updated;
    }

    const t = await shippingService.trackShipment(
      rr.returnShippingCarrier || 'UPS',
      rr.returnTrackingNumber
    );
    const nextStatus = this.resolveReturnStatusFromTracking(t.status, rr.status);
    if (!nextStatus || nextStatus === rr.status) return rr;
    if (!this.validateTransition(rr.status, nextStatus, rr.type)) return rr;

    const data = { status: nextStatus };
    if (nextStatus === 'RECEIVED') data.receivedAt = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.returnRequest.update({
        where: { id: rr.id },
        data,
        include: returnInclude,
      });
      await appendReturnStatusEvent(tx, {
        returnRequestId: rr.id,
        fromStatus: rr.status,
        toStatus: nextStatus,
        note: `Tracking sync · ${t.status || nextStatus}`,
      });
      if (nextStatus === 'RECEIVED') {
        await markUnitsReturnedForReturn(tx, rr.id);
      }
      return row;
    });

    return updated;
  }

  async syncReturnTrackingBatch() {
    const rows = await prisma.returnRequest.findMany({
      where: {
        type: 'REFURBISHMENT',
        returnTrackingNumber: { not: null },
        status: { in: ['LABEL_GENERATED', 'IN_TRANSIT'] },
      },
      take: 40,
      orderBy: { updatedAt: 'asc' },
    });
    let touched = 0;
    for (const row of rows) {
      try {
        await this.syncReturnTracking(row.publicId);
        touched += 1;
      } catch {
        /* ignore per-row carrier errors */
      }
    }
    return { scanned: rows.length, touched };
  }

  async createInspectionRecord(returnPublicId, body, actor) {
    const rr = await prisma.returnRequest.findUnique({
      where: { publicId: returnPublicId },
      include: { refurbishmentJob: true },
    });
    if (!rr) throw new AppError(404, 'Return request not found');

    const inspectorUserId = await resolveActorUserId(actor);
    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.refurbInspectionRecord.create({
        data: {
          returnRequestId: body.target === 'job' ? null : rr.id,
          refurbishmentJobId:
            body.target === 'job' ? rr.refurbishmentJob?.id ?? null : rr.refurbishmentJob?.id ?? null,
          inspectorUserId,
          grade: body.grade,
          notes: body.notes ? String(body.notes).trim() : null,
          photoUrlsJson: body.photoUrls ?? undefined,
          tasksCompletedJson: body.tasksCompleted ?? undefined,
        },
      });
      if (body.target !== 'job') {
        await appendReturnActionNote(tx, {
          returnRequestId: rr.id,
          status: rr.status,
          actorUserId: inspectorUserId,
          note: `Physical inspection recorded${body.grade ? ` · grade ${body.grade}` : ''}`,
        });
      }
      return created;
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'REFURB_INSPECTION_RECORD',
      entityType: 'ReturnRequest',
      entityId: returnPublicId,
      meta: { grade: body.grade },
    });

    return record;
  }

  async awardRefurbStoreCredit(rr) {
    try {
      if (!rr?.id) return 0;

      const result = await prisma.$transaction(async (tx) => {
        const lockedRows = await tx.$queryRaw`
          SELECT
            id,
            "publicId",
            "userId",
            "orderItemId",
            status,
            quantity,
            "acceptedQuantity",
            "creditAwarded"
          FROM "ReturnRequest"
          WHERE id = ${rr.id}
          FOR UPDATE
        `;
        const locked = lockedRows?.[0];
        if (!locked) return { amount: 0, created: false };

        const already = Number(locked.creditAwarded || 0);
        if (already > 0) {
          return { amount: already, created: false, skipped: true };
        }

        // FMA-04: membership must still be active when credit is awarded (not only at request).
        const member = await tx.user.findUnique({
          where: { id: locked.userId },
          select: { accessMemberUntil: true },
        });
        const membershipActive = Boolean(
          member?.accessMemberUntil && new Date(member.accessMemberUntil) > new Date()
        );
        if (!membershipActive) {
          throw new AppError(
            403,
            'Farmhouse Friends membership is required when awarding refurbishment store credit. Membership is no longer active.',
            'REFURB_MEMBERSHIP_REQUIRED'
          );
        }

        let itemMemberPrice = 0;
        let isRefurbishedItem = false;
        if (locked.orderItemId) {
          const line = await tx.orderItem.findUnique({
            where: { id: locked.orderItemId },
            select: {
              price: true,
              memberPriceSnapshot: true,
              product: { select: { productType: true } },
            },
          });
          itemMemberPrice = Number(line?.memberPriceSnapshot ?? line?.price ?? 0);
          isRefurbishedItem = line?.product?.productType === 'REFURBISHED';
        }
        if (itemMemberPrice <= 0) {
          const settings = await getBusinessSettings();
          itemMemberPrice = Number(settings.accessMembershipPriceUsd ?? 50);
        }

        const acceptedQty = Math.max(
          0,
          Number(
            locked.acceptedQuantity != null
              ? locked.acceptedQuantity
              : Math.max(1, Number(locked.quantity ?? 1))
          )
        );
        // Refurbished items are returnable via the used path but earn no store credit.
        const unitCredit = isRefurbishedItem ? 0 : computeRefurbStoreCredit(itemMemberPrice);
        const amount = Math.round(unitCredit * acceptedQty * 100) / 100;

        if (amount <= 0) {
          await tx.returnRequest.update({
            where: { id: locked.id },
            data: { creditAwarded: 0 },
          });
          return { amount: 0, created: false, skipped: true };
        }

        const { awardEarnedCreditInTx, refurbEarnSourceKey } = await import('./wallet.service.js');
        const earn = await awardEarnedCreditInTx(tx, {
          userId: locked.userId,
          amount,
          sourceKey: refurbEarnSourceKey(locked.publicId),
          note: `Reward from approved refurbishment return ${locked.publicId} (${acceptedQty} unit${acceptedQty === 1 ? '' : 's'})`,
        });

        await tx.returnRequest.update({
          where: { id: locked.id },
          data: { creditAwarded: earn.amount },
        });

        if (earn.created) {
          await appendReturnActionNote(tx, {
            returnRequestId: locked.id,
            status: locked.status || rr.status,
            note: `Store credit awarded · $${Number(earn.amount).toFixed(2)} (${acceptedQty} unit${acceptedQty === 1 ? '' : 's'})`,
          });
        }

        return {
          amount: earn.amount,
          created: earn.created,
          skipped: earn.skipped,
          publicId: locked.publicId,
          acceptedQty,
        };
      });

      if (result.created && result.amount > 0) {
        const user =
          rr.user ||
          (await prisma.user.findUnique({
            where: { id: rr.userId },
            select: { email: true, firstName: true, lastName: true },
          }));
        if (user?.email) {
          try {
            await emailService.sendTemplate({
              to: user.email,
              template: 'store-credit-update',
              context: {
                name: [user.firstName, user.lastName].filter(Boolean).join(' '),
                amount: `$${Number(result.amount).toFixed(2)}`,
                actionUrl: `${config.frontend.customerUrl}/dashboard/wallet`,
              },
            });
          } catch (emailErr) {
            console.error('[returns] store credit email failed', result.publicId, emailErr);
          }
        }
      }

      return Number(result.amount || 0);
    } catch (error) {
      if (!isMissingWalletTableError(error)) throw error;
      return 0;
    }
  }

  async updateStatus(returnPublicId, body, actor) {
    const { status, notes, rejectionReason, inspectionChecklist, manualCarrier, manualTrackingNumber, manualShippedAt } =
      body;
    const rr = await resolveReturnRequestRow(returnPublicId, {
      include: {
        user: { select: { email: true, firstName: true, lastName: true } },
        order: { select: { publicId: true } },
      },
    });
    if (!rr) throw new AppError(404, 'Return request not found', 'RETURN_NOT_FOUND');

    // STANDARD: "Mark received" must go through partial receive (or receive remaining).
    if (rr.type === 'STANDARD' && status === 'RECEIVED' && (rr.status === 'REQUESTED' || rr.status === 'RECEIVED')) {
      const siblings = await prisma.returnRequest.findMany({
        where: { submissionPublicId: returnSubmissionKey(rr) },
        orderBy: { createdAt: 'asc' },
      });
      const items = siblings
        .map((line) => {
          const requested = Math.max(1, Number(line.quantity ?? 1));
          const already = Math.max(0, Number(line.receivedQuantity ?? 0));
          const remaining = Math.max(0, requested - already);
          return remaining > 0 ? { lineId: line.publicId, quantity: remaining } : null;
        })
        .filter(Boolean);
      if (!items.length) {
        if (siblings.every((l) => Number(l.receivedQuantity ?? 0) >= Math.max(1, Number(l.quantity ?? 1)))) {
          return this.getById(returnPublicId);
        }
        throw new AppError(400, 'Nothing left to receive for this return');
      }
      return this.receivePackage(returnPublicId, { items, note: notes || body.adminNotes || null }, actor);
    }

    if (
      manualCarrier !== undefined ||
      manualTrackingNumber !== undefined ||
      manualShippedAt !== undefined
    ) {
      await prisma.returnRequest.update({
        where: { id: rr.id },
        data: {
          ...(manualCarrier !== undefined ? { manualCarrier: manualCarrier || null } : {}),
          ...(manualTrackingNumber !== undefined
            ? { manualTrackingNumber: manualTrackingNumber || null }
            : {}),
          ...(manualShippedAt !== undefined
            ? { manualShippedAt: manualShippedAt ? new Date(manualShippedAt) : null }
            : {}),
        },
      });
    }

    if (!status) {
      if (
        notes === undefined &&
        inspectionChecklist === undefined &&
        body.adminNotes === undefined
      ) {
        return this.getById(returnPublicId);
      }
      const updatedNotes = await prisma.returnRequest.update({
        where: { id: rr.id },
        data: {
          ...(notes !== undefined
            ? {
                adminNotes: notes ? String(notes).trim() : null,
              }
            : {}),
          ...(body.adminNotes !== undefined
            ? { adminNotes: body.adminNotes ? String(body.adminNotes).trim() : null }
            : {}),
          ...(inspectionChecklist !== undefined ? { inspectionChecklistJson: inspectionChecklist } : {}),
        },
        include: returnInclude,
      });
      if (inspectionChecklist !== undefined) {
        await appendReturnActionNote(prisma, {
          returnRequestId: rr.id,
          status: rr.status,
          actorUserId: await resolveActorUserId(actor),
          note: 'Inspection checklist saved',
        });
      }
      await writeAdminAudit({
        actorId: actor?.id,
        actorEmail: actor?.email,
        action: inspectionChecklist !== undefined ? 'RETURN_CHECKLIST' : 'RETURN_NOTES',
        entityType: 'ReturnRequest',
        entityId: returnPublicId,
        meta: { adminNotes: updatedNotes.adminNotes, inspectionChecklist },
      });
      return this.getById(returnPublicId);
    }

    if (rr.status === status) {
      if (notes === undefined && body.adminNotes === undefined) return this.getById(returnPublicId);
      const updatedNotes = await prisma.returnRequest.update({
        where: { id: rr.id },
        data: {
          ...(notes !== undefined ? { adminNotes: notes ? String(notes).trim() : null } : {}),
          ...(body.adminNotes !== undefined
            ? { adminNotes: body.adminNotes ? String(body.adminNotes).trim() : null }
            : {}),
        },
        include: returnInclude,
      });
      await writeAdminAudit({
        actorId: actor?.id,
        actorEmail: actor?.email,
        action: 'RETURN_NOTES',
        entityType: 'ReturnRequest',
        entityId: returnPublicId,
        meta: { adminNotes: updatedNotes.adminNotes },
      });
      return this.getById(returnPublicId);
    }

    // STANDARD: start inspection only on lines that already have received qty; leave others REQUESTED.
    if (rr.type === 'STANDARD' && status === 'UNDER_INSPECTION') {
      const siblings = await prisma.returnRequest.findMany({
        where: { submissionPublicId: returnSubmissionKey(rr) },
        orderBy: { createdAt: 'asc' },
      });
      const targets = siblings.filter(
        (s) =>
          lineReceivedQty(s) > 0 &&
          ['REQUESTED', 'RECEIVED'].includes(s.status)
      );
      if (!targets.length) {
        if (siblings.some((s) => s.status === 'UNDER_INSPECTION')) {
          return this.getById(returnPublicId);
        }
        throw new AppError(400, 'Receive units before starting inspection');
      }

      const actorUserId = await resolveActorUserId(actor);
      const notesVal =
        notes !== undefined
          ? notes
            ? String(notes).trim()
            : null
          : body.adminNotes !== undefined
            ? body.adminNotes
              ? String(body.adminNotes).trim()
              : null
            : undefined;

      await prisma.$transaction(async (tx) => {
        for (const line of targets) {
          await tx.returnRequest.update({
            where: { id: line.id },
            data: {
              status: 'UNDER_INSPECTION',
              ...(notesVal !== undefined ? { adminNotes: notesVal } : {}),
            },
          });
          await appendReturnStatusEvent(tx, {
            returnRequestId: line.id,
            fromStatus: line.status,
            toStatus: 'UNDER_INSPECTION',
            actorUserId,
            note: notesVal || 'Inspection started for received units',
          });
        }
      });

      await writeAdminAudit({
        actorId: actor?.id,
        actorEmail: actor?.email,
        action: 'RETURN_STATUS',
        entityType: 'ReturnRequest',
        entityId: returnPublicId,
        meta: {
          from: 'mixed',
          to: 'UNDER_INSPECTION',
          lineIds: targets.map((t) => t.publicId),
        },
      });

      try {
        const updated = await prisma.returnRequest.findUnique({
          where: { id: targets[0].id },
          include: {
            user: { select: { email: true, firstName: true, lastName: true } },
            order: { select: { publicId: true } },
          },
        });
        if (updated) notifyInspectionQueued(updated);
      } catch (err) {
        console.error('[returns] inspection queued notification failed', returnPublicId, err);
      }

      return this.getById(returnPublicId);
    }

    if (!this.validateTransition(rr.status, status, rr.type)) {
      throw new AppError(400, `Invalid return status transition: ${rr.status} -> ${status}`);
    }

    if (
      rr.type === 'STANDARD' &&
      (status === 'APPROVED' || status === 'REJECTED') &&
      rr.status === 'UNDER_INSPECTION'
    ) {
      const checklist = inspectionChecklist ?? rr.inspectionChecklistJson;
      if (!checklistComplete(checklist)) {
        throw new AppError(400, 'Complete and save the inspection checklist before approving or rejecting');
      }
      if (status === 'REJECTED') {
        const reason = rejectionReason ? String(rejectionReason).trim() : '';
        if (!reason) throw new AppError(400, 'Rejection reason is required');
      }
    }

    const data = { status };
    if (notes !== undefined) data.adminNotes = notes ? String(notes).trim() : null;
    if (body.adminNotes !== undefined) {
      data.adminNotes = body.adminNotes ? String(body.adminNotes).trim() : null;
    }
    if (rejectionReason !== undefined) {
      data.rejectionReason = rejectionReason ? String(rejectionReason).trim() : null;
    }
    if (inspectionChecklist !== undefined) {
      data.inspectionChecklistJson = inspectionChecklist;
    }
    if (status === 'RECEIVED') data.receivedAt = new Date();
    if (status === 'INSPECTION_APPROVED') data.inspectionApprovedAt = new Date();

    // Quantity outcomes when approving/rejecting a STANDARD line without inspect-line.
    if (rr.type === 'STANDARD' && status === 'APPROVED' && rr.status === 'UNDER_INSPECTION') {
      if (data.acceptedQuantity == null && body.acceptedQuantity == null) {
        data.acceptedQuantity = rr.quantity;
        data.rejectedQuantity = 0;
      }
    }
    if (rr.type === 'STANDARD' && status === 'REJECTED' && rr.status === 'UNDER_INSPECTION') {
      if (data.rejectedQuantity == null && body.rejectedQuantity == null) {
        data.rejectedQuantity = rr.quantity;
        data.acceptedQuantity = 0;
      }
    }
    if (body.acceptedQuantity !== undefined) {
      data.acceptedQuantity = Math.max(0, Number(body.acceptedQuantity) || 0);
    }
    if (body.rejectedQuantity !== undefined) {
      data.rejectedQuantity = Math.max(0, Number(body.rejectedQuantity) || 0);
    }

    const actorUserId = await resolveActorUserId(actor);

    // Package-level transitions stay in sync for STANDARD and REFURB siblings in the same status.
    // Line decisions (approve/reject after inspection) stay per-line.
    const isLineDecision =
      (rr.type === 'STANDARD' && (status === 'APPROVED' || status === 'REJECTED')) ||
      (rr.type === 'REFURBISHMENT' &&
        (status === 'INSPECTION_APPROVED' || status === 'INSPECTION_REJECTED' || status === 'ELIGIBILITY_REJECTED'));
    const refurbPackageStatuses = ['APPROVED', 'LABEL_GENERATED', 'IN_TRANSIT', 'RECEIVED', 'UNDER_INSPECTION'];
    const siblingIds =
      !isLineDecision &&
      ((rr.type === 'STANDARD') ||
        (rr.type === 'REFURBISHMENT' && refurbPackageStatuses.includes(status)))
        ? (
            await prisma.returnRequest.findMany({
              where: { submissionPublicId: rr.submissionPublicId },
              select: { id: true, status: true, publicId: true },
            })
          )
            .filter((s) => s.status === rr.status)
            .map((s) => s.id)
        : [rr.id];

    const updated = await prisma.$transaction(async (tx) => {
      let primary = null;
      for (const sid of siblingIds) {
        const row = await tx.returnRequest.update({
          where: { id: sid },
          data,
          include: returnInclude,
        });
        await appendReturnStatusEvent(tx, {
          returnRequestId: sid,
          fromStatus: rr.status,
          toStatus: status,
          actorUserId,
          note: data.adminNotes || data.rejectionReason || null,
        });
        if (sid === rr.id) primary = row;
      }
      return primary;
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'RETURN_STATUS',
      entityType: 'ReturnRequest',
      entityId: returnPublicId,
      meta: {
        from: rr.status,
        to: status,
        adminNotes: data.adminNotes,
        rejectionReason: data.rejectionReason,
        lineOnly: isLineDecision,
      },
    });

    if (status === 'RECEIVED') {
      await prisma.$transaction(async (tx) => {
        for (const sid of siblingIds) {
          await markUnitsReturnedForReturn(tx, sid);
        }
      });
    }

    if (status === 'UNDER_INSPECTION') {
      try {
        notifyInspectionQueued(updated);
      } catch (err) {
        console.error('[returns] inspection queued notification failed', returnPublicId, err);
      }
    }

    // STANDARD approve no longer auto-refunds or auto-restocks (plan 39–41).

    if (status === 'INSPECTION_APPROVED' && rr.type === 'REFURBISHMENT') {
      await refurbishmentService.createJobForReturn(rr.id);
      const full = await prisma.returnRequest.findUnique({
        where: { id: rr.id },
        include: {
          user: { select: { email: true, firstName: true, lastName: true } },
          inspectionRecords: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      await this.awardRefurbStoreCredit({ ...rr, ...full, ...updated });
      const withJob = await prisma.returnRequest.findUnique({
        where: { id: rr.id },
        include: returnInclude,
      });
      if (withJob) {
        await emailService.sendTemplate({
          to: rr.user.email,
          template: 'return-status',
          context: {
            name: [rr.user.firstName, rr.user.lastName].filter(Boolean).join(' '),
            status,
            actionUrl: `${config.frontend.customerUrl}/dashboard/returns/${rr.submissionPublicId || returnPublicId}`,
          },
        });
        return this.getById(returnPublicId);
      }
    }

    const emailNote =
      status === 'REJECTED' || status === 'INSPECTION_REJECTED'
        ? data.rejectionReason || 'See return details for more information.'
        : status === 'APPROVED' && rr.type === 'STANDARD'
          ? 'Your return was approved. Your refund will be processed next. Original shipping charges are not refunded.'
          : undefined;

    await emailService.sendTemplate({
      to: rr.user.email,
      template: 'return-status',
      context: {
        name: [rr.user.firstName, rr.user.lastName].filter(Boolean).join(' '),
        status,
        note: emailNote,
        actionUrl: `${config.frontend.customerUrl}/dashboard/returns/${rr.submissionPublicId || returnPublicId}`,
      },
    });

    return this.getById(returnPublicId);
  }

  /**
   * Per-line inspection: checklist + accepted/rejected qty (STANDARD),
   * or accepted/rejected qty + store credit (REFURBISHMENT).
   */
  async inspectLine(returnPublicId, body, actor) {
    const lineId = body.lineId ? String(body.lineId) : returnPublicId;
    const inspectInclude = {
      user: { select: { email: true, firstName: true, lastName: true, id: true } },
      order: { select: { publicId: true } },
      orderItem: {
        select: {
          productId: true,
          productVariantId: true,
          price: true,
          memberPriceSnapshot: true,
          product: { select: { id: true, publicId: true, productType: true } },
        },
      },
      refurbishmentJob: true,
    };
    let rr = await prisma.returnRequest.findUnique({
      where: { publicId: lineId },
      include: inspectInclude,
    });
    if (!rr) {
      // Allow submission id + lineId
      const submission = await prisma.returnRequest.findFirst({
        where: {
          OR: [{ submissionPublicId: returnPublicId }, { returnNumber: returnPublicId }],
        },
        select: { submissionPublicId: true },
      });
      if (submission && body.lineId) {
        rr = await prisma.returnRequest.findUnique({
          where: { publicId: String(body.lineId) },
          include: inspectInclude,
        });
      }
    }
    if (!rr) throw new AppError(404, 'Return line not found');

    if (rr.type === 'REFURBISHMENT') {
      return this.inspectRefurbLine(rr, returnPublicId, body, actor);
    }
    if (rr.type !== 'STANDARD') {
      throw new AppError(400, 'Line inspection applies to standard or refurbishment returns only');
    }
    const receivedQty = lineReceivedQty(rr);
    if (receivedQty <= 0) {
      throw new AppError(400, 'No units have been received for this line yet');
    }
    if (
      !['REQUESTED', 'RECEIVED', 'UNDER_INSPECTION', 'APPROVED', 'REJECTED'].includes(rr.status)
    ) {
      throw new AppError(400, `Cannot inspect line in status ${rr.status}`);
    }
    if (rr.stripeRefundId || rr.refundedAt) {
      throw new AppError(400, 'Cannot change inspection after refund has been processed');
    }

    const returnedQty = receivedQty;
    const acceptedQuantity =
      body.acceptedQuantity !== undefined
        ? Math.max(0, Number(body.acceptedQuantity) || 0)
        : rr.acceptedQuantity ?? 0;
    const rejectedQuantity =
      body.rejectedQuantity !== undefined
        ? Math.max(0, Number(body.rejectedQuantity) || 0)
        : rr.rejectedQuantity ?? 0;

    if (acceptedQuantity + rejectedQuantity !== returnedQty) {
      throw new AppError(
        400,
        `Accepted (${acceptedQuantity}) + rejected (${rejectedQuantity}) must equal received quantity (${returnedQty})`
      );
    }

    const inspectionChecklist =
      body.inspectionChecklist !== undefined ? body.inspectionChecklist : rr.inspectionChecklistJson;
    if (!checklistComplete(inspectionChecklist)) {
      throw new AppError(400, 'Complete the inspection checklist for this line');
    }

    const rejectionReason =
      body.rejectionReason !== undefined
        ? body.rejectionReason
          ? String(body.rejectionReason).trim()
          : null
        : rr.rejectionReason;
    if (rejectedQuantity > 0 && !rejectionReason) {
      throw new AppError(400, 'Rejection reason is required when rejecting units');
    }

    const inspectorPhotoUrls =
      body.inspectorPhotoUrls !== undefined
        ? Array.isArray(body.inspectorPhotoUrls)
          ? body.inspectorPhotoUrls.filter((u) => typeof u === 'string' && u.trim())
          : null
        : rr.inspectorPhotoUrlsJson;

    if (rejectedQuantity > 0 && body.complete && (!inspectorPhotoUrls || !inspectorPhotoUrls.length)) {
      throw new AppError(400, 'At least one evidence photo is required when rejecting units');
    }

    const disposition =
      body.disposition !== undefined
        ? body.disposition
          ? String(body.disposition).toUpperCase()
          : null
        : rr.disposition;
    if (disposition && !['RESTOCK', 'DISCARD', 'REFURB'].includes(disposition)) {
      throw new AppError(400, 'disposition must be RESTOCK, DISCARD, or REFURB');
    }
    if (
      disposition === 'REFURB' &&
      rr.orderItem?.product?.productType === 'REFURBISHED'
    ) {
      throw new AppError(
        400,
        'Refurbished products cannot be moved to refurbishment again'
      );
    }
    const dispositionQuantity =
      body.dispositionQuantity !== undefined
        ? Math.max(0, Number(body.dispositionQuantity) || 0)
        : rr.dispositionQuantity;

    const rejectedDisposition =
      body.rejectedDisposition !== undefined
        ? body.rejectedDisposition
          ? String(body.rejectedDisposition).toUpperCase()
          : null
        : rr.rejectedDisposition;
    if (rejectedDisposition && !['DAMAGED', 'DISCARD'].includes(rejectedDisposition)) {
      throw new AppError(400, 'rejectedDisposition must be DAMAGED or DISCARD');
    }

    const nextStatus = acceptedQuantity > 0 ? 'APPROVED' : 'REJECTED';
    const promoteToInspection = ['REQUESTED', 'RECEIVED'].includes(rr.status);
    const isReDecision =
      Boolean(body.complete) && ['APPROVED', 'REJECTED'].includes(rr.status);
    const shouldTransition =
      Boolean(body.complete) &&
      (rr.status === 'UNDER_INSPECTION' || promoteToInspection || isReDecision);

    const actorUserId = await resolveActorUserId(actor);
    const data = {
      acceptedQuantity,
      rejectedQuantity,
      inspectionChecklistJson: inspectionChecklist,
      rejectionReason: rejectedQuantity > 0 ? rejectionReason : null,
      inspectorPhotoUrlsJson: inspectorPhotoUrls,
      ...(body.adminNotes !== undefined
        ? { adminNotes: body.adminNotes ? String(body.adminNotes).trim() : null }
        : {}),
      ...(disposition !== undefined ? { disposition } : {}),
      ...(dispositionQuantity !== undefined ? { dispositionQuantity } : {}),
      ...(rejectedDisposition !== undefined
        ? { rejectedDisposition: rejectedQuantity > 0 ? rejectedDisposition : null }
        : {}),
      ...(shouldTransition
        ? { status: nextStatus }
        : promoteToInspection
          ? { status: 'UNDER_INSPECTION' }
          : {}),
    };

    await prisma.$transaction(async (tx) => {
      await tx.returnRequest.update({
        where: { id: rr.id },
        data,
      });
      if (shouldTransition) {
        if (promoteToInspection) {
          await appendReturnStatusEvent(tx, {
            returnRequestId: rr.id,
            fromStatus: rr.status,
            toStatus: 'UNDER_INSPECTION',
            actorUserId,
            note: 'Inspection started for received units',
          });
          await appendReturnStatusEvent(tx, {
            returnRequestId: rr.id,
            fromStatus: 'UNDER_INSPECTION',
            toStatus: nextStatus,
            actorUserId,
            note:
              nextStatus === 'REJECTED'
                ? rejectionReason
                : `Inspected: accepted ${acceptedQuantity}, rejected ${rejectedQuantity}`,
          });
        } else if (isReDecision && rr.status === nextStatus) {
          await appendReturnActionNote(tx, {
            returnRequestId: rr.id,
            status: rr.status,
            actorUserId,
            note: `Inspection updated · accepted ${acceptedQuantity} / rejected ${rejectedQuantity}`,
          });
        } else {
          await appendReturnStatusEvent(tx, {
            returnRequestId: rr.id,
            fromStatus: rr.status,
            toStatus: nextStatus,
            actorUserId,
            note:
              nextStatus === 'REJECTED'
                ? rejectionReason
                : isReDecision
                  ? `Inspection updated: accepted ${acceptedQuantity}, rejected ${rejectedQuantity}`
                  : `Inspected: accepted ${acceptedQuantity}, rejected ${rejectedQuantity}`,
          });
        }

        // Audit discard / refurb dispositions for Inventory Overview (zero stock delta).
        const disp = String(disposition || '').toUpperCase();
        const dispQty = Math.max(0, Number(dispositionQuantity ?? acceptedQuantity) || 0);
        const productId = rr.orderItem?.productId || rr.orderItem?.product?.id;
        if (
          productId &&
          acceptedQuantity > 0 &&
          dispQty > 0 &&
          (disp === 'DISCARD' || disp === 'REFURB')
        ) {
          await writeInventoryLedger(tx, {
            productId,
            productVariantId: rr.orderItem?.productVariantId || null,
            quantityDelta: 0,
            eventType: 'ADJUST',
            referenceType: 'return',
            referenceId: rr.publicId,
            actorUserId,
            note:
              disp === 'DISCARD'
                ? returnLedgerNote('DISCARD', rr.returnNumber || rr.publicId) ||
                  `Discarded ${dispQty} unit(s) from return (no restock)`
                : returnLedgerNote('REFURB', rr.returnNumber || rr.publicId) ||
                  `Moved ${dispQty} unit(s) to refurbishment from return`,
          });
        }

        const rejDisp = String(rejectedDisposition || 'DAMAGED').toUpperCase();
        if (productId && rejectedQuantity > 0 && rejDisp === 'DISCARD') {
          await writeInventoryLedger(tx, {
            productId,
            productVariantId: rr.orderItem?.productVariantId || null,
            quantityDelta: 0,
            eventType: 'ADJUST',
            referenceType: 'return',
            referenceId: rr.publicId,
            actorUserId,
            note:
              returnLedgerNote('DISCARD', rr.returnNumber || rr.publicId) ||
              `Discarded ${rejectedQuantity} rejected unit(s) from return`,
          });
        }
      } else if (promoteToInspection) {
        await appendReturnStatusEvent(tx, {
          returnRequestId: rr.id,
          fromStatus: rr.status,
          toStatus: 'UNDER_INSPECTION',
          actorUserId,
          note: 'Inspection started for received units',
        });
      } else {
        await appendReturnActionNote(tx, {
          returnRequestId: rr.id,
          status: rr.status,
          actorUserId,
          note: `Line inspection saved · accepted ${acceptedQuantity} / rejected ${rejectedQuantity}`,
        });
      }
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: shouldTransition ? 'RETURN_LINE_DECIDE' : 'RETURN_LINE_INSPECT',
      entityType: 'ReturnRequest',
      entityId: rr.publicId,
      meta: { acceptedQuantity, rejectedQuantity, nextStatus: shouldTransition ? nextStatus : null },
    });

    if (shouldTransition && rr.user?.email && (!isReDecision || rr.status !== nextStatus)) {
      const emailNote =
        nextStatus === 'REJECTED'
          ? rejectionReason || 'See return details for more information.'
          : rejectedQuantity > 0
            ? `Partial approval: ${acceptedQuantity} unit(s) accepted, ${rejectedQuantity} rejected.`
            : 'Your return was approved. Your refund will be processed next. Original shipping charges are not refunded.';
      await emailService.sendTemplate({
        to: rr.user.email,
        template: 'return-status',
        context: {
          name: [rr.user.firstName, rr.user.lastName].filter(Boolean).join(' '),
          status: nextStatus,
          note: emailNote,
          actionUrl: `${config.frontend.customerUrl}/dashboard/returns/${rr.submissionPublicId || returnPublicId}`,
        },
      });
    }

    return this.getById(rr.submissionPublicId || returnPublicId);
  }

  /**
   * Per-quantity REFURB physical inspection on a single submission line.
   */
  async inspectRefurbLine(rr, returnPublicId, body, actor) {
    if (!['RECEIVED', 'UNDER_INSPECTION'].includes(rr.status)) {
      throw new AppError(400, `Cannot inspect refurb line in status ${rr.status}`);
    }
    if (Number(rr.creditAwarded || 0) > 0) {
      throw new AppError(400, 'Cannot change inspection after store credit has been awarded');
    }

    const inspectableQty = refurbInspectableQty(rr);
    const acceptedQuantity =
      body.acceptedQuantity !== undefined
        ? Math.max(0, Number(body.acceptedQuantity) || 0)
        : rr.acceptedQuantity ?? 0;
    const rejectedQuantity =
      body.rejectedQuantity !== undefined
        ? Math.max(0, Number(body.rejectedQuantity) || 0)
        : rr.rejectedQuantity ?? 0;

    if (acceptedQuantity + rejectedQuantity !== inspectableQty) {
      throw new AppError(
        400,
        `Accepted (${acceptedQuantity}) + rejected (${rejectedQuantity}) must equal inspectable quantity (${inspectableQty})`
      );
    }

    const rejectionReason =
      body.rejectionReason !== undefined
        ? body.rejectionReason
          ? String(body.rejectionReason).trim()
          : null
        : rr.rejectionReason;
    if (rejectedQuantity > 0 && !rejectionReason) {
      throw new AppError(400, 'Rejection reason is required when rejecting units');
    }

    const inspectorPhotoUrls =
      body.inspectorPhotoUrls !== undefined
        ? Array.isArray(body.inspectorPhotoUrls)
          ? body.inspectorPhotoUrls.filter((u) => typeof u === 'string' && u.trim())
          : null
        : rr.inspectorPhotoUrlsJson;

    if (rejectedQuantity > 0 && body.complete && (!inspectorPhotoUrls || !inspectorPhotoUrls.length)) {
      throw new AppError(400, 'At least one evidence photo is required when rejecting units');
    }

    const notes =
      body.notes !== undefined
        ? body.notes
          ? String(body.notes).trim()
          : null
        : body.adminNotes !== undefined
          ? body.adminNotes
            ? String(body.adminNotes).trim()
            : null
          : undefined;

    const nextStatus = acceptedQuantity > 0 ? 'INSPECTION_APPROVED' : 'INSPECTION_REJECTED';
    const shouldTransition = Boolean(body.complete);
    const actorUserId = await resolveActorUserId(actor);

    const data = {
      acceptedQuantity,
      rejectedQuantity,
      rejectionReason: rejectedQuantity > 0 ? rejectionReason : null,
      inspectorPhotoUrlsJson: inspectorPhotoUrls,
      ...(notes !== undefined ? { adminNotes: notes } : {}),
      ...(shouldTransition
        ? {
            status: nextStatus,
            ...(nextStatus === 'INSPECTION_APPROVED' ? { inspectionApprovedAt: new Date() } : {}),
          }
        : rr.status === 'RECEIVED'
          ? { status: 'UNDER_INSPECTION' }
          : {}),
    };

    await prisma.$transaction(async (tx) => {
      await tx.returnRequest.update({
        where: { id: rr.id },
        data,
      });

      if (shouldTransition) {
        if (rr.status === 'RECEIVED') {
          await appendReturnStatusEvent(tx, {
            returnRequestId: rr.id,
            fromStatus: 'RECEIVED',
            toStatus: 'UNDER_INSPECTION',
            actorUserId,
            note: 'Physical inspection started',
          });
          await appendReturnStatusEvent(tx, {
            returnRequestId: rr.id,
            fromStatus: 'UNDER_INSPECTION',
            toStatus: nextStatus,
            actorUserId,
            note:
              nextStatus === 'INSPECTION_REJECTED'
                ? rejectionReason
                : `Physical inspection: accepted ${acceptedQuantity}, rejected ${rejectedQuantity}`,
          });
        } else {
          await appendReturnStatusEvent(tx, {
            returnRequestId: rr.id,
            fromStatus: rr.status,
            toStatus: nextStatus,
            actorUserId,
            note:
              nextStatus === 'INSPECTION_REJECTED'
                ? rejectionReason
                : `Physical inspection: accepted ${acceptedQuantity}, rejected ${rejectedQuantity}`,
          });
        }
      } else if (rr.status === 'RECEIVED') {
        await appendReturnStatusEvent(tx, {
          returnRequestId: rr.id,
          fromStatus: 'RECEIVED',
          toStatus: 'UNDER_INSPECTION',
          actorUserId,
          note: 'Physical inspection started',
        });
      } else {
        await appendReturnActionNote(tx, {
          returnRequestId: rr.id,
          status: 'UNDER_INSPECTION',
          actorUserId,
          note: `Refurb inspection draft · accepted ${acceptedQuantity} / rejected ${rejectedQuantity}`,
        });
      }
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: shouldTransition ? 'REFURB_LINE_DECIDE' : 'REFURB_LINE_INSPECT',
      entityType: 'ReturnRequest',
      entityId: rr.publicId,
      meta: {
        acceptedQuantity,
        rejectedQuantity,
        nextStatus: shouldTransition ? nextStatus : null,
      },
    });

    if (shouldTransition && nextStatus === 'INSPECTION_APPROVED') {
      await refurbishmentService.createJobForReturn(rr.id);
      const full = await prisma.returnRequest.findUnique({
        where: { id: rr.id },
        include: {
          user: { select: { email: true, firstName: true, lastName: true } },
          inspectionRecords: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
      });
      await this.awardRefurbStoreCredit({
        ...rr,
        ...full,
        acceptedQuantity,
        rejectedQuantity,
        status: nextStatus,
      });
    }

    if (shouldTransition && rr.user?.email) {
      const emailNote =
        nextStatus === 'INSPECTION_REJECTED'
          ? rejectionReason || 'See return details for more information.'
          : rejectedQuantity > 0
            ? `Partial approval: ${acceptedQuantity} unit(s) accepted for store credit, ${rejectedQuantity} rejected.`
            : 'Your used-product return passed inspection. Store credit has been added to your wallet.';
      await emailService.sendTemplate({
        to: rr.user.email,
        template: 'return-status',
        context: {
          name: [rr.user.firstName, rr.user.lastName].filter(Boolean).join(' '),
          status: nextStatus,
          note: emailNote,
          actionUrl: `${config.frontend.customerUrl}/dashboard/returns/${rr.submissionPublicId || returnPublicId}`,
        },
      });
    }

    return this.getById(rr.submissionPublicId || returnPublicId);
  }

  /**
   * Process Stripe refunds for APPROVED STANDARD lines with acceptedQuantity > 0.
   */
  async processRefund(returnPublicId, actor) {
    const detail = await this.getById(returnPublicId);
    if (detail.type !== 'STANDARD') {
      throw new AppError(400, 'Refunds apply to standard returns only');
    }
    const items = detail.submissionItems?.length
      ? detail.submissionItems
      : [
          {
            id: detail.primaryItemId || detail.id,
            status: detail.status,
            stripeRefundId: detail.stripeRefundId,
            acceptedQuantity: detail.acceptedQuantity,
          },
        ];

    const pending = items.filter((item) => {
      const accepted =
        item.acceptedQuantity != null
          ? Number(item.acceptedQuantity)
          : item.status === 'APPROVED'
            ? Math.max(1, Number(item.quantity ?? 1))
            : 0;
      return item.status === 'APPROVED' && accepted > 0 && !item.stripeRefundId;
    });
    if (!pending.length) {
      const alreadyDone = items.every(
        (item) =>
          item.stripeRefundId ||
          item.refundAmount != null ||
          item.status === 'REJECTED' ||
          Number(item.acceptedQuantity ?? 0) === 0
      );
      if (alreadyDone) return this.getById(returnPublicId);
      throw new AppError(400, 'Return must be approved with accepted units before processing a refund');
    }

    for (const item of pending) {
      const row = await prisma.returnRequest.findUnique({
        where: { publicId: item.id },
        select: {
          id: true,
          publicId: true,
          type: true,
          stripeRefundId: true,
          status: true,
          acceptedQuantity: true,
          quantity: true,
        },
      });
      if (!row) continue;
      try {
        await processStandardReturnRefund(row, actor);
      } catch (err) {
        if (err instanceof AppError && err.code === 'STRIPE_NOT_CONFIGURED') {
          // Dev without Stripe — leave refund fields null.
          continue;
        }
        throw err;
      }
    }
    return this.getById(returnPublicId);
  }

  async restockReturn(returnPublicId, body, actor) {
    const rr = await prisma.returnRequest.findFirst({
      where: {
        OR: [{ publicId: returnPublicId }, { submissionPublicId: returnPublicId }],
      },
      include: { orderItem: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!rr) throw new AppError(404, 'Return request not found');
    if (rr.type !== 'STANDARD') {
      throw new AppError(400, 'Restock applies to standard returns only');
    }

    const siblings = await prisma.returnRequest.findMany({
      where: { submissionPublicId: rr.submissionPublicId },
      include: { orderItem: true },
      orderBy: { createdAt: 'asc' },
    });
    const restockable = siblings.filter((s) => {
      const accepted = lineAcceptedQty(s);
      return (s.status === 'APPROVED' || accepted > 0) && accepted > 0;
    });
    if (!restockable.length) {
      throw new AppError(400, 'Approve accepted units before restocking inventory');
    }
    if (!siblings.every((s) => s.status === 'APPROVED' || s.status === 'REJECTED')) {
      throw new AppError(400, 'Finish inspection on all lines before restocking');
    }

    const selections = Array.isArray(body?.items) ? body.items : null;
    const actorUserId = await resolveActorUserId(actor);

    await prisma.$transaction(async (tx) => {
      for (const sibling of restockable) {
        if (sibling.restockedAt) continue;
        const maxQty = lineAcceptedQty(sibling);
        if (maxQty <= 0) continue;
        let qty = maxQty;
        if (selections) {
          const sel = selections.find(
            (s) => s.returnItemId === sibling.publicId || s.id === sibling.publicId
          );
          if (!sel) continue;
          qty = Math.min(maxQty, Math.max(1, Number(sel.quantity ?? maxQty)));
        }
        // Disposition DISCARD skips restock unless explicitly selected
        if (!selections && sibling.disposition === 'DISCARD') continue;
        if (!sibling.orderItem) continue;
        const product = await tx.product.findUnique({
          where: { id: sibling.orderItem.productId },
          include: { variants: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!product) continue;
        await restockOrderLineStock(
          tx,
          product,
          sibling.orderItem.productVariantId,
          qty,
          {
            referenceType: 'return',
            referenceId: sibling.publicId,
            actorUserId,
            note: returnLedgerNote(
              'RESTOCK',
              sibling.returnNumber || sibling.publicId,
              sibling.type
            ),
          },
          'RESTOCK'
        );
        await tx.returnRequest.update({
          where: { id: sibling.id },
          data: {
            restockedAt: new Date(),
            restockedQuantity: qty,
            disposition: sibling.disposition || 'RESTOCK',
            dispositionQuantity: qty,
          },
        });
        await appendReturnActionNote(tx, {
          returnRequestId: sibling.id,
          status: sibling.status,
          actorUserId,
          note: `Restocked ${qty} unit${qty === 1 ? '' : 's'} to inventory`,
        });
      }
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'RETURN_RESTOCK',
      entityType: 'ReturnRequest',
      entityId: returnPublicId,
      meta: { items: selections },
    });

    return this.getById(returnPublicId);
  }

  /**
   * Approve (if needed) → Stripe refund → per-line restock for clean RESTOCK lines.
   * Idempotent via stripeRefundId / restockedAt. Never restocks before refund succeeds.
   */
  async approveAndSettle(returnPublicId, body, actor) {
    const requestedLineIds = Array.isArray(body?.lineIds)
      ? body.lineIds.map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (!requestedLineIds.length) {
      throw new AppError(400, 'lineIds is required');
    }

    const rr = await prisma.returnRequest.findFirst({
      where: {
        OR: [{ publicId: returnPublicId }, { submissionPublicId: returnPublicId }],
      },
      select: { submissionPublicId: true, type: true, publicId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!rr) throw new AppError(404, 'Return request not found');
    if (rr.type !== 'STANDARD') {
      throw new AppError(400, 'Approve & Settle applies to standard returns only');
    }

    const submissionKey = rr.submissionPublicId || rr.publicId;
    const siblings = await prisma.returnRequest.findMany({
      where: { submissionPublicId: submissionKey, type: 'STANDARD' },
      include: {
        orderItem: {
          include: { product: { select: { id: true, productType: true, name: true } } },
        },
        order: {
          select: {
            paymentStatus: true,
            publicId: true,
            taxAmount: true,
            stripePaymentIntentId: true,
            stripeCheckoutSessionId: true,
            orderItems: { select: { price: true, quantity: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const byId = new Map();
    for (const s of siblings) {
      byId.set(s.publicId, s);
      byId.set(String(s.id), s);
    }

    const { getStripe } = await import('./payment.service.js');
    if (!getStripe()) {
      throw new AppError(503, 'Stripe is not configured', 'STRIPE_NOT_CONFIGURED');
    }

    const results = [];
    let stopBatch = false;

    for (const lineId of requestedLineIds) {
      if (stopBatch) {
        results.push({
          lineId,
          productName: null,
          ok: false,
          error: 'Stopped after an unexpected payment error on a previous line',
          steps: { approved: false, refunded: false, restocked: false },
        });
        continue;
      }

      let line = byId.get(lineId);
      if (!line) {
        results.push({
          lineId,
          productName: null,
          ok: false,
          error: 'Unknown return line',
          steps: { approved: false, refunded: false, restocked: false },
        });
        continue;
      }

      const productName = line.orderItem?.product?.name || 'Item';
      const eligibility = evaluateStandardSettleEligibility(line);
      if (!eligibility.eligible) {
        results.push({
          lineId: line.publicId,
          productName,
          ok: false,
          error: eligibility.reason || 'Not eligible for Approve & Settle',
          steps: { approved: false, refunded: false, restocked: false },
        });
        continue;
      }

      {
        const { isRefundablePaymentStatus } = await import('../lib/order-refund-balance.js');
        if (line.order?.paymentStatus && !isRefundablePaymentStatus(line.order.paymentStatus)) {
          results.push({
            lineId: line.publicId,
            productName,
            ok: false,
            error: 'Order is not in a refundable payment state',
            steps: { approved: false, refunded: false, restocked: false },
          });
          continue;
        }
      }

      const steps = {
        approved: line.status === 'APPROVED',
        refunded: Boolean(line.stripeRefundId || line.refundedAt),
        restocked: Boolean(line.restockedAt),
        refundAmount: line.refundAmount != null ? Number(line.refundAmount) : 0,
        restockedQty: line.restockedQuantity != null ? Number(line.restockedQuantity) : 0,
        stripeRefundId: line.stripeRefundId || null,
      };

      try {
        // 1) Approve if needed
        if (line.status !== 'APPROVED') {
          await this.inspectLine(
            submissionKey,
            {
              lineId: line.publicId,
              acceptedQuantity: Math.max(0, Number(line.acceptedQuantity ?? 0)),
              rejectedQuantity: Math.max(0, Number(line.rejectedQuantity ?? 0)),
              inspectionChecklist: line.inspectionChecklistJson,
              rejectionReason: line.rejectionReason,
              inspectorPhotoUrls: line.inspectorPhotoUrlsJson,
              disposition: 'RESTOCK',
              dispositionQuantity: Math.max(0, Number(line.acceptedQuantity ?? 0)),
              rejectedDisposition: line.rejectedDisposition,
              complete: true,
            },
            actor
          );
          steps.approved = true;
          line = await prisma.returnRequest.findUnique({
            where: { id: line.id },
            include: {
              orderItem: {
                include: { product: { select: { id: true, productType: true, name: true } } },
              },
              order: {
                select: {
                  paymentStatus: true,
                  publicId: true,
                  taxAmount: true,
                  stripePaymentIntentId: true,
                  stripeCheckoutSessionId: true,
                  orderItems: { select: { price: true, quantity: true } },
                },
              },
            },
          });
          if (!line || line.status !== 'APPROVED') {
            throw new AppError(400, 'Approve step did not leave the line APPROVED');
          }
        }

        // 2) Refund (never restock before this succeeds)
        if (!line.stripeRefundId && !line.refundedAt) {
          const refundResult = await processStandardReturnRefund(line, actor);
          steps.refunded = true;
          steps.refundAmount = Number(refundResult.refundAmount || 0);
          steps.stripeRefundId = refundResult.stripeRefundId || null;
          line = await prisma.returnRequest.findUnique({
            where: { id: line.id },
            include: {
              orderItem: true,
            },
          });
        } else {
          steps.refunded = true;
          steps.refundAmount = Number(line.refundAmount || 0);
          steps.stripeRefundId = line.stripeRefundId || null;
        }

        // 3) Restock this line only
        if (!line.restockedAt) {
          const restocked = await restockStandardLinesExplicit(
            [
              {
                ...line,
                type: 'STANDARD',
                disposition: line.disposition || 'RESTOCK',
              },
            ],
            actor
          );
          const qty = restocked[0]?.quantity ?? lineAcceptedQty(line);
          steps.restocked = true;
          steps.restockedQty = qty;
          await writeAdminAudit({
            actorId: actor?.id,
            actorEmail: actor?.email,
            action: 'RETURN_RESTOCK',
            entityType: 'ReturnRequest',
            entityId: line.publicId,
            meta: { items: [{ returnItemId: line.publicId, quantity: qty }], via: 'approve_and_settle' },
          });
        } else {
          steps.restocked = true;
          steps.restockedQty = Number(line.restockedQuantity || lineAcceptedQty(line));
        }

        results.push({
          lineId: line.publicId,
          productName,
          ok: true,
          error: null,
          steps,
        });
      } catch (err) {
        const message =
          err instanceof AppError
            ? err.message
            : err?.message || 'Approve & Settle failed for this line';
        const isApp = err instanceof AppError;
        const unexpectedStripe =
          !isApp ||
          (err.code &&
            String(err.code).startsWith('STRIPE') &&
            err.code !== 'STRIPE_NOT_CONFIGURED' &&
            err.statusCode >= 500);

        results.push({
          lineId: line.publicId,
          productName,
          ok: false,
          error: message,
          steps,
        });

        if (unexpectedStripe || (!isApp && err?.type === 'StripeError')) {
          stopBatch = true;
        }
        // Known AppErrors: continue remaining eligible lines.
      }
    }

    const totals = results.reduce(
      (acc, r) => {
        if (r.ok && r.steps) {
          acc.refundAmount += Number(r.steps.refundAmount || 0);
          acc.restockQuantity += Number(r.steps.restockedQty || 0);
        }
        return acc;
      },
      { refundAmount: 0, restockQuantity: 0 }
    );
    totals.refundAmount = Math.round(totals.refundAmount * 100) / 100;

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'RETURN_APPROVE_AND_SETTLE',
      entityType: 'ReturnRequest',
      entityId: submissionKey,
      meta: {
        lineIds: requestedLineIds,
        results,
        totals,
      },
    });

    const detail = await this.getById(submissionKey);
    return {
      eligibleCount: results.filter((r) => r.ok).length,
      results,
      totals,
      return: detail,
    };
  }

  async getPackageRequestForSubmission(rows) {
    const orderId = rows[0]?.orderId;
    const returnRequestId = rows[0]?.id;
    if (!orderId) return null;
    const linked = returnRequestId
      ? await prisma.returnPackageRequest.findFirst({
          where: {
            returnRequestId,
            status: { in: ['REQUESTED', 'APPROVED', 'SENT'] },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            publicId: true,
            status: true,
            reason: true,
            comments: true,
            dispatchDate: true,
            uspsTrackingNumber: true,
            expectedDeliveryDate: true,
            adminNotes: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : null;
    if (linked) return linked;
    return prisma.returnPackageRequest.findFirst({
      where: {
        orderId,
        status: { in: ['REQUESTED', 'APPROVED', 'SENT'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        publicId: true,
        status: true,
        reason: true,
        comments: true,
        dispatchDate: true,
        uspsTrackingNumber: true,
        expectedDeliveryDate: true,
        adminNotes: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async submitCustomerUspsShipment(userPublicId, returnPublicId, { trackingNumber, note, shippedAt, photoUrl }) {
    const user = await prisma.user.findUnique({ where: { publicId: userPublicId }, select: { id: true } });
    if (!user) throw new AppError(401, 'Unauthorized');

    const rows = await this._loadUserSubmissionRows(user.id, returnPublicId);
    const primary = rows[0];
    if (primary.type !== 'REFURBISHMENT') throw new AppError(400, 'Only refurbishment returns accept UPS shipment details');
    if (!['APPROVED', 'LABEL_GENERATED'].includes(primary.status)) {
      throw new AppError(400, 'Return is not awaiting your shipment details');
    }

    const tracking = String(trackingNumber || '').trim();
    if (!tracking) throw new AppError(400, 'UPS tracking number is required');

    const shipped = shippedAt ? new Date(shippedAt) : new Date();
    const noteTrimmed = note ? String(note).trim() : null;
    const photo = photoUrl && String(photoUrl).startsWith('/uploads/returns/') ? String(photoUrl) : null;

    const receiveDeadline = refurbShipByDeadline(shipped);

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        await tx.returnRequest.update({
          where: { id: row.id },
          data: {
            status: 'IN_TRANSIT',
            manualCarrier: 'UPS',
            manualTrackingNumber: tracking,
            manualShippedAt: shipped,
            customerShippingNote: noteTrimmed,
            customerShippingPhotoUrl: photo,
            customerShippingSubmittedAt: new Date(),
            shipByDeadline: receiveDeadline,
            keepWaitingUntil: null,
          },
        });
        await appendReturnStatusEvent(tx, {
          returnRequestId: row.id,
          fromStatus: row.status,
          toStatus: 'IN_TRANSIT',
          actorUserId: user.id,
          note: noteTrimmed ? `Customer shipped via UPS · ${noteTrimmed}` : 'Customer shipped via UPS',
        });
      }
    });

    return this.getForUser(userPublicId, returnPublicId);
  }

  async cancelByUser(userPublicId, returnPublicId, { reason } = {}) {
    const user = await prisma.user.findUnique({ where: { publicId: userPublicId }, select: { id: true } });
    if (!user) throw new AppError(401, 'Unauthorized');

    const rows = await this._loadUserSubmissionRows(user.id, returnPublicId);
    const primary = rows[0];
    if (!['APPROVED', 'ELIGIBILITY_REVIEW', 'REQUESTED'].includes(primary.status)) {
      throw new AppError(400, 'This return can no longer be cancelled online');
    }

    const note = reason ? String(reason).trim() : 'Cancelled by customer';

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        await tx.returnRequest.update({
          where: { id: row.id },
          data: { status: 'CANCELLED', notes: note },
        });
        await appendReturnStatusEvent(tx, {
          returnRequestId: row.id,
          fromStatus: row.status,
          toStatus: 'CANCELLED',
          actorUserId: user.id,
          note,
        });
      }
    });

    return this.getForUser(userPublicId, returnPublicId);
  }

  async keepWaiting(returnPublicId, actor) {
    const rr = await resolveReturnRequestRow(returnPublicId);
    if (!rr) throw new AppError(404, 'Return request not found', 'RETURN_NOT_FOUND');
    if (rr.type !== 'REFURBISHMENT') throw new AppError(400, 'Only refurbishment returns support keep waiting');
    if (!['APPROVED', 'IN_TRANSIT'].includes(rr.status)) {
      throw new AppError(400, 'Return is not in a shippable state');
    }

    const activeDeadline = rr.keepWaitingUntil || rr.shipByDeadline;
    if (!activeDeadline) {
      throw new AppError(400, 'Expected receive date is not set yet — waiting for customer UPS tracking or envelope dispatch');
    }
    if (new Date() <= new Date(activeDeadline)) {
      throw new AppError(400, 'Keep waiting is only available after the expected receive date has passed');
    }

    const actorUserId = await resolveActorUserId(actor);
    const submissionKey = rr.submissionPublicId || rr.publicId;
    const siblings = await prisma.returnRequest.findMany({
      where: { submissionPublicId: submissionKey },
      select: { id: true, status: true },
    });

    const extended = refurbShipByDeadline(rr.keepWaitingUntil || rr.shipByDeadline || new Date());

    await prisma.$transaction(async (tx) => {
      for (const row of siblings) {
        await tx.returnRequest.update({
          where: { id: row.id },
          data: { keepWaitingUntil: extended },
        });
        await appendReturnStatusEvent(tx, {
          returnRequestId: row.id,
          fromStatus: row.status,
          toStatus: row.status,
          actorUserId,
          note: `Keep waiting until ${extended.toLocaleDateString()}`,
        });
      }
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'RETURN_KEEP_WAITING',
      entityType: 'ReturnRequest',
      entityId: returnPublicId,
      meta: { keepWaitingUntil: extended.toISOString() },
    });

    return this.getById(returnPublicId);
  }

  async _loadUserSubmissionRows(userId, returnPublicId) {
    let rows = await prisma.returnRequest.findMany({
      where: {
        userId,
        OR: [
          { publicId: returnPublicId },
          { submissionPublicId: returnPublicId },
          { returnNumber: returnPublicId },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!rows.length) throw new AppError(404, 'Return request not found');
    if (rows.length === 1) {
      const key = returnSubmissionKey(rows[0]);
      if (key && key !== returnPublicId) {
        rows = await prisma.returnRequest.findMany({
          where: { userId, submissionPublicId: key },
          orderBy: { createdAt: 'asc' },
        });
      }
    }
    return rows;
  }

  /**
   * Record a warehouse package receipt (partial or full) for a STANDARD return submission.
   * Increments receivedQuantity per line; marks that line RECEIVED when its own qty is complete.
   * Sibling lines may still be awaiting packages or already under inspection.
   */
  async receivePackage(returnPublicId, body, actor) {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) throw new AppError(400, 'At least one line quantity is required');

    let anchor = await prisma.returnRequest.findUnique({ where: { publicId: returnPublicId } });
    if (!anchor) {
      anchor = await prisma.returnRequest.findFirst({
        where: {
          OR: [{ submissionPublicId: returnPublicId }, { returnNumber: returnPublicId }],
        },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!anchor) throw new AppError(404, 'Return request not found');
    if (anchor.type !== 'STANDARD') {
      throw new AppError(400, 'Package receiving applies to standard returns only');
    }

    const submissionKey = returnSubmissionKey(anchor);
    const siblings = await prisma.returnRequest.findMany({
      where: { submissionPublicId: submissionKey },
      orderBy: { createdAt: 'asc' },
    });
    if (!siblings.length) throw new AppError(404, 'Return request not found');

    const byPublicId = new Map(siblings.map((s) => [s.publicId, s]));
    const receiveNow = [];
    for (const raw of items) {
      const lineId = String(raw.lineId || '').trim();
      const qty = Math.max(0, Number(raw.quantity) || 0);
      if (!lineId) continue;
      const line = byPublicId.get(lineId);
      if (!line) throw new AppError(400, `Unknown return line: ${lineId}`);
      // Decided lines are locked; other siblings may still receive while inspection continues.
      if (['APPROVED', 'REJECTED'].includes(line.status)) {
        throw new AppError(400, `Cannot receive units for line in status ${line.status}`);
      }
      if (!['REQUESTED', 'RECEIVED', 'UNDER_INSPECTION'].includes(line.status)) {
        throw new AppError(400, `Cannot receive units for line in status ${line.status}`);
      }
      const requested = lineRequestedQty(line);
      const already = lineReceivedQty(line);
      const remaining = Math.max(0, requested - already);
      if (qty > remaining) {
        throw new AppError(
          400,
          `Cannot receive ${qty} for line (requested ${requested}, already received ${already}, remaining ${remaining})`
        );
      }
      if (qty > 0) receiveNow.push({ line, qty, requested, already });
    }

    if (!receiveNow.length) {
      throw new AppError(400, 'Enter at least one received quantity greater than zero');
    }

    const actorUserId = await resolveActorUserId(actor);
    const note = body?.note ? String(body.note).trim() : null;

    const result = await prisma.$transaction(async (tx) => {
      const last = await tx.returnReceivePackage.findFirst({
        where: { submissionPublicId: submissionKey },
        orderBy: { packageNumber: 'desc' },
        select: { packageNumber: true },
      });
      const packageNumber = (last?.packageNumber || 0) + 1;

      const pkg = await tx.returnReceivePackage.create({
        data: {
          submissionPublicId: submissionKey,
          packageNumber,
          receivedByUserId: actorUserId,
          note,
          lines: {
            create: receiveNow.map(({ line, qty }) => ({
              returnRequestId: line.id,
              quantityReceived: qty,
            })),
          },
        },
        include: {
          lines: true,
          receivedBy: {
            select: { publicId: true, firstName: true, lastName: true, email: true },
          },
        },
      });

      for (const { line, qty, requested, already } of receiveNow) {
        const nextReceived = already + qty;
        const lineFull = nextReceived >= requested;
        // Per-line RECEIVED when this product's qty is complete; leave UNDER_INSPECTION as-is.
        const promoteReceived = lineFull && line.status === 'REQUESTED';
        const data = {
          receivedQuantity: nextReceived,
          ...(promoteReceived
            ? { status: 'RECEIVED', receivedAt: line.receivedAt || new Date() }
            : {}),
        };
        await tx.returnRequest.update({ where: { id: line.id }, data });
        await appendReturnStatusEvent(tx, {
          returnRequestId: line.id,
          fromStatus: line.status,
          toStatus: promoteReceived ? 'RECEIVED' : line.status,
          actorUserId,
          note: `Package #${packageNumber}: received ${qty} of ${requested} (total ${nextReceived}/${requested})`,
        });
        if (promoteReceived) {
          await markUnitsReturnedForReturn(tx, line.id);
        }
      }

      const refreshed = await tx.returnRequest.findMany({
        where: { submissionPublicId: submissionKey },
      });
      const allFull = refreshed.every((l) => !lineHasRemaining(l));

      return { pkg, allFull, packageNumber };
    });

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'RETURN_RECEIVE_PACKAGE',
      entityType: 'ReturnRequest',
      entityId: returnPublicId,
      meta: {
        packageNumber: result.packageNumber,
        allFull: result.allFull,
        items: receiveNow.map(({ line, qty }) => ({ lineId: line.publicId, quantity: qty })),
      },
    });

    return this.getById(returnPublicId);
  }

  async listReceivePackages(submissionPublicId) {
    const rows = await prisma.returnReceivePackage.findMany({
      where: { submissionPublicId },
      orderBy: { packageNumber: 'asc' },
      include: {
        receivedBy: {
          select: { publicId: true, firstName: true, lastName: true, email: true },
        },
        lines: {
          include: {
            returnRequest: {
              select: {
                publicId: true,
                quantity: true,
                receivedQuantity: true,
                orderItem: {
                  include: {
                    product: { select: { name: true, sku: true } },
                    productVariant: { select: { sku: true, combination: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    return rows.map((pkg) => ({
      id: pkg.publicId,
      packageNumber: pkg.packageNumber,
      note: pkg.note,
      createdAt: pkg.createdAt,
      receivedBy: pkg.receivedBy
        ? {
            publicId: pkg.receivedBy.publicId,
            name:
              [pkg.receivedBy.firstName, pkg.receivedBy.lastName].filter(Boolean).join(' ') ||
              pkg.receivedBy.email,
            email: pkg.receivedBy.email,
          }
        : null,
      lines: pkg.lines.map((ln) => ({
        id: ln.publicId,
        lineId: ln.returnRequest.publicId,
        quantityReceived: ln.quantityReceived,
        productName: ln.returnRequest.orderItem?.product?.name || 'Item',
        sku:
          ln.returnRequest.orderItem?.productVariant?.sku ||
          ln.returnRequest.orderItem?.product?.sku ||
          null,
        requestedQuantity: ln.returnRequest.quantity,
        totalReceivedQuantity: ln.returnRequest.receivedQuantity,
      })),
    }));
  }

  async bulkMarkReceived(returnPublicIds, actor) {
    const results = [];
    for (const id of returnPublicIds) {
      try {
        const row = await this.updateStatus(id, { status: 'RECEIVED' }, actor);
        results.push({ id, ok: true, return: row });
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    return { results };
  }

  /**
   * Lightweight cursor for inspection triage (ids + position only).
   * Stages map to actionable line statuses; visibility matches admin queue.
   */
  async getTriageCursor({ stage, cursor, direction = 'current' } = {}) {
    const STAGE_STATUSES = {
      eligibility: ['ELIGIBILITY_REVIEW'],
      receive: ['IN_TRANSIT', 'LABEL_GENERATED'],
      physical: ['RECEIVED', 'UNDER_INSPECTION'],
    };
    const statuses = STAGE_STATUSES[String(stage || '')];
    if (!statuses) {
      throw new AppError(400, 'Invalid triage stage. Use eligibility, receive, or physical.');
    }

    let rows = await prisma.returnRequest.findMany({
      where: { type: 'REFURBISHMENT', status: { in: statuses } },
      select: {
        id: true,
        publicId: true,
        submissionPublicId: true,
        status: true,
        createdAt: true,
        orderId: true,
        customerShippingSubmittedAt: true,
        manualTrackingNumber: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const orderIds = [...new Set(rows.map((r) => r.orderId).filter(Boolean))];
    const openPkgOrders = await loadOpenPackageOrderIds(orderIds);
    rows = rows.filter((row) => isRefurbVisibleToAdmin(row, openPkgOrders));

    const total = rows.length;
    if (!total) {
      return {
        empty: true,
        stage,
        total: 0,
        position: 0,
        lineId: null,
        submissionId: null,
        status: null,
        nextLineId: null,
        prevLineId: null,
      };
    }

    let index = 0;
    const cursorId = cursor ? String(cursor).trim() : '';
    if (cursorId) {
      const found = rows.findIndex((r) => r.publicId === cursorId);
      if (found >= 0) {
        if (direction === 'next') index = found + 1;
        else if (direction === 'prev') index = found - 1;
        else index = found;
      } else if (direction === 'prev') {
        // Stale cursor at start — stay at first item.
        index = 0;
      } else {
        // Stale/missing cursor (completed or concurrent): resume at first remaining.
        // FE prefers nextLineId captured before mutation when available.
        index = 0;
      }
    }

    if (index < 0) {
      // Prev past the first item — stay on first (no wrap loop).
      index = 0;
    }
    if (index >= total) {
      return {
        empty: true,
        stage,
        total,
        position: total,
        lineId: null,
        submissionId: null,
        status: null,
        nextLineId: null,
        prevLineId: rows[total - 1]?.publicId ?? null,
        completed: true,
      };
    }

    const current = rows[index];
    return {
      empty: false,
      completed: false,
      stage,
      total,
      position: index + 1,
      lineId: current.publicId,
      submissionId: current.submissionPublicId || current.publicId,
      status: current.status,
      nextLineId: rows[index + 1]?.publicId ?? null,
      prevLineId: rows[index - 1]?.publicId ?? null,
    };
  }
}

export const returnsService = new ReturnsService();
