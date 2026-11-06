/**
 * ORD-001 — shared Order list/count query builders.
 *
 * Pure Prisma `where` fragments. No UI, no side effects, no deriveOrderPresentation.
 * Counts and lists that share a definition MUST call the same builder.
 *
 * P6c: Admin operational queues use buildAdminStatusGroupWhere().
 * Dashboard pendingFulfillment still uses buildLegacyAdminPendingCountWhere() (legacy meaning).
 */

/** @typedef {import('@prisma/client').Prisma.OrderWhereInput} OrderWhereInput */

const WAREHOUSE_PAYMENT = { in: ['PAID', 'PARTIALLY_REFUNDED'] };
const NOT_TERMINAL_ORDER_STATUS = { notIn: ['CANCELLED', 'REFUNDED'] };

// ─── Approved target semantics (P6-DECISION / P6c) ────────────────────────────

/** Active unpaid checkout — not FAILED (mixed superseded/expired meanings). */
export function buildPaymentPendingWhere() {
  return {
    paymentStatus: 'UNPAID',
  };
}

const WAREHOUSE_INTAKE_FULFILLMENT = { in: ['NEW_ORDER', 'ACCEPTED'] };

/**
 * Warehouse intake — paid, pre-pick (New + In process).
 * Kept for dashboard deep links (`to_fulfill` / legacy `pending`).
 * PARTIALLY_REFUNDED remains fulfillable when active lines remain.
 */
export function buildToFulfillWhere() {
  return {
    fulfillmentStatus: WAREHOUSE_INTAKE_FULFILLMENT,
    paymentStatus: WAREHOUSE_PAYMENT,
    status: NOT_TERMINAL_ORDER_STATUS,
  };
}

/**
 * Prototype “New” — paid warehouse intake with no pick progress yet.
 */
export function buildNewOrderQueueWhere() {
  return {
    AND: [
      buildToFulfillWhere(),
      { orderItems: { every: { pickedQuantity: 0 } } },
    ],
  };
}

/**
 * Prototype “In process” — picking started, not yet Ready to ship.
 */
export function buildInProcessWhere() {
  return {
    AND: [
      buildToFulfillWhere(),
      { orderItems: { some: { pickedQuantity: { gt: 0 } } } },
    ],
  };
}

/**
 * Picked / labeled — ready for carrier handoff (prototype “Ready to ship”).
 * Includes LABEL_GENERATED; not yet physically shipped.
 */
export function buildPickupReadyWhere() {
  return {
    fulfillmentStatus: { in: ['PICKUP_READY', 'LABEL_GENERATED'] },
    paymentStatus: WAREHOUSE_PAYMENT,
    status: NOT_TERMINAL_ORDER_STATUS,
  };
}

/** Alias — same predicate as pickup_ready. */
export function buildReadyToShipWhere() {
  return buildPickupReadyWhere();
}

/**
 * Physical shipment lifecycle. Tracking/label alone must NOT match.
 * IN_TRANSIT / OUT_FOR_DELIVERY are substates of this queue (not separate tabs).
 */
export function buildShippedWhere() {
  return {
    fulfillmentStatus: { in: ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'] },
  };
}

/** Shipping console — any order with label/tracking/shipment lifecycle. */
export function buildHasShipmentWhere() {
  return {
    OR: [
      {
        fulfillmentStatus: {
          in: ['LABEL_GENERATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'],
        },
      },
      { trackingNumber: { not: null } },
      { shippingLabelUrl: { not: null } },
    ],
  };
}

/** Prototype “Label created” tab (includes legacy PICKUP_READY + label rows). */
export function buildLabelCreatedWhere() {
  return {
    OR: [
      { fulfillmentStatus: 'LABEL_GENERATED' },
      {
        AND: [
          { shippingLabelUrl: { not: null } },
          { fulfillmentStatus: 'PICKUP_READY' },
          { outboundShippedAt: null },
        ],
      },
    ],
  };
}

/** Prototype “In transit” tab (includes Out for delivery). */
export function buildInTransitWhere() {
  return {
    fulfillmentStatus: { in: ['IN_TRANSIT', 'OUT_FOR_DELIVERY'] },
  };
}

/** Prototype “Exceptions” — tracking copy or status hint. */
export function buildShippingExceptionWhere() {
  return {
    AND: [
      buildHasShipmentWhere(),
      {
        OR: [
          { trackingStatus: { contains: 'Exception', mode: 'insensitive' } },
          { trackingStatus: { contains: 'exception', mode: 'insensitive' } },
          { trackingStatusDetails: { contains: 'exception', mode: 'insensitive' } },
        ],
      },
    ],
  };
}

/** Manual shipments — tracking without purchased label URL. */
export function buildManualShipmentWhere() {
  return {
    AND: [
      { trackingNumber: { not: null } },
      {
        OR: [{ shippingLabelUrl: null }, { shippingLabelUrl: '' }],
      },
      {
        fulfillmentStatus: {
          in: ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'LABEL_GENERATED'],
        },
      },
    ],
  };
}

/** Packed / ready to ship without a label yet (banner + create picker). */
export function buildNeedsShippingLabelWhere() {
  return {
    AND: [
      { fulfillmentStatus: 'PICKUP_READY' },
      { paymentStatus: WAREHOUSE_PAYMENT },
      { status: NOT_TERMINAL_ORDER_STATUS },
      { shippingLabelUrl: null },
      { trackingNumber: null },
    ],
  };
}

/** Prototype Shipping tab “Shipped” (not in-transit/OFD). */
export function buildShipmentShippedOnlyWhere() {
  return { fulfillmentStatus: 'SHIPPED' };
}

/**
 * Delivered with historical Order.status fallback.
 */
export function buildDeliveredWhere() {
  return {
    OR: [
      { fulfillmentStatus: 'DELIVERED' },
      { deliveredAt: { not: null } },
      { status: 'DELIVERED' },
    ],
  };
}

/** Fully cancelled order only (not partial line cancel). */
export function buildCancelledWhere() {
  return { status: 'CANCELLED' };
}

/**
 * Completed / accepted returned merchandise (Orders → Returned) — P6b.
 */
export function buildReturnedWhere() {
  return {
    OR: [
      {
        returnRequests: {
          some: {
            OR: [
              { type: 'STANDARD', status: 'APPROVED' },
              { type: 'REFURBISHMENT', status: 'INSPECTION_APPROVED' },
            ],
          },
        },
      },
      { status: 'RETURNED' },
    ],
  };
}

/** Fully refunded payment — paymentStatus authority. */
export function buildRefundedWhere() {
  return { paymentStatus: 'REFUNDED' };
}

/** Partial refunds — may overlap warehouse queues. */
export function buildPartiallyRefundedWhere() {
  return { paymentStatus: 'PARTIALLY_REFUNDED' };
}

export const COMPLETED_RETURN_MATCH = Object.freeze({
  STANDARD: 'APPROVED',
  REFURBISHMENT: 'INSPECTION_APPROVED',
});

/**
 * Canonical Admin Orders `statusGroup` keys → builders (P6c).
 * List and count must use the same mapping.
 */
export const ADMIN_STATUS_GROUP_BUILDERS = Object.freeze({
  payment_pending: buildPaymentPendingWhere,
  to_fulfill: buildToFulfillWhere,
  new: buildNewOrderQueueWhere,
  in_process: buildInProcessWhere,
  pickup_ready: buildPickupReadyWhere,
  ready_to_ship: buildReadyToShipWhere,
  shipped: buildShippedWhere,
  delivered: buildDeliveredWhere,
  cancelled: buildCancelledWhere,
  returned: buildReturnedWhere,
  refunded: buildRefundedWhere,
  partially_refunded: buildPartiallyRefundedWhere,
  // Shipping Management console tabs
  shipments: buildHasShipmentWhere,
  label_created: buildLabelCreatedWhere,
  shipment_shipped: buildShipmentShippedOnlyWhere,
  in_transit: buildInTransitWhere,
  exceptions: buildShippingExceptionWhere,
  manual: buildManualShipmentWhere,
  needs_label: buildNeedsShippingLabelWhere,
});

/**
 * Resolve Admin `statusGroup` to a Prisma where fragment.
 *
 * Aliases (deep links / older clients):
 * - `pending` → `to_fulfill` (dashboard “Awaiting fulfillment” historically linked here;
 *   unpaid checkout is now `payment_pending`)
 * - `ready_to_ship` → same as `pickup_ready`
 *
 * Granular `status` (Order.status enum) only applies when combined with a group that
 * still filters primarily by Order.status (`cancelled`). For operational groups the
 * queue builder is authoritative; incompatible granular values → `{ id: -1 }`.
 *
 * @param {string|null|undefined} statusGroup
 * @param {string|null|undefined} [granularStatus]
 * @returns {OrderWhereInput|null}
 */
export function buildAdminStatusGroupWhere(statusGroup, granularStatus) {
  const raw = statusGroup && String(statusGroup).trim();
  if (!raw) return null;

  const sg = raw === 'pending' ? 'to_fulfill' : raw;
  const builder = ADMIN_STATUS_GROUP_BUILDERS[sg];
  if (!builder) return null;

  const st = granularStatus && String(granularStatus).trim();
  // Queue tabs own their predicate. Granular Order.status only applies on Cancelled
  // (and is cleared by Admin FE when switching tabs). Ignore leftover granular on others.
  if (st && sg === 'cancelled') {
    if (st !== 'CANCELLED') return { id: -1 };
    return buildCancelledWhere();
  }

  return builder();
}

/** @deprecated Use buildAdminStatusGroupWhere — kept as alias for P6b call sites. */
export function buildLegacyAdminStatusGroupWhere(statusGroup, granularStatus) {
  return buildAdminStatusGroupWhere(statusGroup, granularStatus);
}

// ─── Legacy dashboard count (intentionally NOT migrated in P6c) ───────────────

/** @type {Readonly<Record<string, readonly string[]>>} */
export const LEGACY_ADMIN_STATUS_GROUPS = Object.freeze({
  pending: Object.freeze(['PENDING', 'PROCESSING', 'CONFIRMED']),
  shipped: Object.freeze(['SHIPPED']),
  delivered: Object.freeze(['DELIVERED']),
  cancelled: Object.freeze(['CANCELLED']),
  returned: Object.freeze(['RETURNED']),
});

/**
 * Legacy dashboard `pendingFulfillment` / `pendingOrders`.
 * Still Order.status ∈ PENDING|PROCESSING|CONFIRMED — not To Fulfill.
 * Left unchanged in P6c (product meaning differs from new queues).
 */
export function buildLegacyAdminPendingCountWhere() {
  return { status: { in: [...LEGACY_ADMIN_STATUS_GROUPS.pending] } };
}

// ─── Customer list / stats (P6d) ──────────────────────────────────────────────

/** Terminal Order.status values excluded from Active (Delivered uses triad separately). */
export const CUSTOMER_ACTIVE_EXCLUDED_STATUSES = Object.freeze([
  'CANCELLED',
  'REFUNDED',
  'RETURNED',
]);

/** @deprecated Use CUSTOMER_ACTIVE_EXCLUDED_STATUSES — kept for older imports. */
export const LEGACY_CUSTOMER_TERMINAL_STATUSES = Object.freeze([
  'DELIVERED',
  ...CUSTOMER_ACTIVE_EXCLUDED_STATUSES,
]);

/** Physical shipping lifecycle for customer `inTransit` metric (not tracking). */
export const CUSTOMER_IN_TRANSIT_FULFILLMENT = Object.freeze([
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
]);

/**
 * Canonical Delivered triad — list, count, FE `isDeliveredOrder`, return eligibility.
 * Same three arms as Admin {@link buildDeliveredWhere} (order of OR arms may differ).
 */
export function buildCustomerDeliveredWhere() {
  return {
    OR: [
      { status: 'DELIVERED' },
      { fulfillmentStatus: 'DELIVERED' },
      { deliveredAt: { not: null } },
    ],
  };
}

/**
 * Active = not delivered (triad) AND not fully cancelled/refunded/returned.
 * Includes unpaid, warehouse, and physical ship states (SHIPPED / IN_TRANSIT / OFD).
 */
export function buildCustomerActiveWhere() {
  return {
    AND: [
      { NOT: buildCustomerDeliveredWhere() },
      { status: { notIn: [...CUSTOMER_ACTIVE_EXCLUDED_STATUSES] } },
    ],
  };
}

/**
 * Customer `inTransit` metric — physical shipment only.
 * Tracking/label alone must NOT match. Historical: status=SHIPPED + null fulfillment.
 */
export function buildCustomerInTransitWhere() {
  return {
    AND: [
      { NOT: buildCustomerDeliveredWhere() },
      { status: { notIn: [...CUSTOMER_ACTIVE_EXCLUDED_STATUSES] } },
      {
        OR: [
          { fulfillmentStatus: { in: [...CUSTOMER_IN_TRANSIT_FULFILLMENT] } },
          {
            AND: [{ status: 'SHIPPED' }, { fulfillmentStatus: null }],
          },
        ],
      },
    ],
  };
}

/** Customer Returns tab — any ReturnRequest (not Admin completed Returned). */
export function buildCustomerHasAnyReturnWhere() {
  return { returnRequests: { some: {} } };
}

// ─── In-memory mirrors (stats tests / FE parity documentation) ───────────────

/**
 * @param {{ status?: string|null, fulfillmentStatus?: string|null, deliveredAt?: Date|string|null }} order
 */
export function matchCustomerDelivered(order) {
  const st = String(order?.status || '').toUpperCase();
  const fs =
    order?.fulfillmentStatus != null && String(order.fulfillmentStatus).trim() !== ''
      ? String(order.fulfillmentStatus).toUpperCase()
      : '';
  if (st === 'DELIVERED') return true;
  if (fs === 'DELIVERED') return true;
  if (order?.deliveredAt != null && order.deliveredAt !== '') return true;
  return false;
}

/**
 * @param {{ status?: string|null, fulfillmentStatus?: string|null, deliveredAt?: Date|string|null }} order
 */
export function matchCustomerActive(order) {
  if (matchCustomerDelivered(order)) return false;
  const st = String(order?.status || '').toUpperCase();
  if (CUSTOMER_ACTIVE_EXCLUDED_STATUSES.includes(st)) return false;
  return true;
}

/**
 * @param {{ status?: string|null, fulfillmentStatus?: string|null, deliveredAt?: Date|string|null, trackingNumber?: string|null }} order
 */
export function matchCustomerInTransit(order) {
  if (!matchCustomerActive(order)) return false;
  const fs =
    order?.fulfillmentStatus != null && String(order.fulfillmentStatus).trim() !== ''
      ? String(order.fulfillmentStatus).toUpperCase()
      : null;
  if (fs && CUSTOMER_IN_TRANSIT_FULFILLMENT.includes(fs)) return true;
  const st = String(order?.status || '').toUpperCase();
  if (st === 'SHIPPED' && fs == null) return true;
  return false;
}
