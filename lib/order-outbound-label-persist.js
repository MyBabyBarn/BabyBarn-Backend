import { AppError } from '../utils/error-handler.js';

/**
 * ORD-001-P4 — shared outbound shipping-label persistence.
 *
 * Label purchase ≠ shipped. Authoritative Admin path and legacy POST /shipping/labels
 * both persist tracking + LABEL_GENERATED (when safe), never Order.status=SHIPPED.
 */

const TERMINAL_ORDER_STATUSES = new Set(['CANCELLED', 'REFUNDED', 'RETURNED']);

/** Fulfillment stages at/after true shipment — do not regress to PICKUP_READY. */
const PAST_LABEL_FULFILLMENT = new Set([
  'SHIPPED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]);

/**
 * @param {{ status?: string | null }} order
 */
export function assertOrderAllowsOutboundLabelPersist(order) {
  const status = String(order?.status || '').toUpperCase();
  if (TERMINAL_ORDER_STATUSES.has(status)) {
    throw new AppError(
      400,
      `Cannot attach an outbound shipping label while the order is ${status.toLowerCase()}`,
      'ORDER_LABEL_NOT_ALLOWED'
    );
  }
}

/**
 * Whether it is safe to set fulfillmentStatus = PICKUP_READY for a new/updated label.
 * False when already shipped/delivered (or Order.status already past ship).
 *
 * @param {{ status?: string | null, fulfillmentStatus?: string | null }} order
 */
export function shouldSetPickupReadyFromOutboundLabel(order) {
  const status = String(order?.status || '').toUpperCase();
  if (status === 'SHIPPED' || status === 'DELIVERED') return false;
  const fs = String(order?.fulfillmentStatus || '').toUpperCase();
  if (PAST_LABEL_FULFILLMENT.has(fs)) return false;
  return true;
}

/**
 * Build Prisma Order update data after a successful outbound UPS label purchase.
 *
 * @param {object} args
 * @param {object} args.order — current order row
 * @param {object} args.label — provider label result
 * @param {object} [args.packageDetailsJson]
 * @param {string|null} [args.shipmentId]
 * @param {object|null} [args.selectedRateUpdate] — prebuilt selected-rate fields
 * @param {Date} [args.at]
 * @returns {{ data: object, setPickupReady: boolean }}
 */
export function buildOutboundLabelPersistData({
  order,
  label,
  packageDetailsJson,
  shipmentId,
  selectedRateUpdate,
  at = new Date(),
} = {}) {
  assertOrderAllowsOutboundLabelPersist(order);
  const setPickupReady = shouldSetPickupReadyFromOutboundLabel(order);

  const data = {
    ...(label?.trackingNumber ? { trackingNumber: label.trackingNumber } : {}),
    ...(label?.shippingCarrier ? { shippingCarrier: label.shippingCarrier } : {}),
    ...(label?.shippingLabelUrl ? { shippingLabelUrl: label.shippingLabelUrl } : {}),
    ...(label?.transactionId ? { shippingTransactionId: label.transactionId } : {}),
    ...(shipmentId ? { shippingShipmentId: String(shipmentId) } : {}),
    ...(selectedRateUpdate && typeof selectedRateUpdate === 'object' ? selectedRateUpdate : {}),
    ...(packageDetailsJson !== undefined ? { packageDetailsJson } : {}),
    labelGeneratedAt: at,
    trackingStatus: 'LABEL_CREATED',
    trackingStatusDetails: 'UPS shipping label generated',
    trackingStatusDate: at,
  };

  if (setPickupReady) {
    // Label purchased ≠ shipped. LABEL_GENERATED drives Shipping “Label created”.
    data.fulfillmentStatus = 'LABEL_GENERATED';
    if (!order.pickupReadyAt) {
      data.pickupReadyAt = at;
    }
    if (order.fulfillmentStatus === 'NEW_ORDER' || !order.fulfillmentAcceptedAt) {
      data.fulfillmentAcceptedAt = at;
    }
  }

  // Never force Order.status / outboundShippedAt / deliveredAt here.
  return { data, setPickupReady };
}
