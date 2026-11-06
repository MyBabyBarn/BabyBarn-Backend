/**
 * ORD-001 Phase 5A — derived order presentation (display only).
 *
 * Pure, deterministic, side-effect free. Does not mutate input.
 * Does not change Order.status writers, eligibility, or filters.
 */

/**
 * @typedef {object} OrderPresentationInput
 * @property {string|null|undefined} [status]
 * @property {string|null|undefined} [paymentStatus]
 * @property {string|null|undefined} [fulfillmentStatus]
 * @property {string|Date|null|undefined} [deliveredAt]
 * @property {string|null|undefined} [trackingNumber]
 * @property {string|null|undefined} [trackingStatus]
 * @property {string|Date|null|undefined} [outboundShippedAt]
 * @property {string|Date|null|undefined} [fulfillmentAcceptedAt]
 * @property {string|null|undefined} [shippingLabelUrl]
 * @property {string|null|undefined} [fullReturnLabel]
 * @property {boolean|undefined} [hasActiveReturn]
 * @property {boolean|undefined} [hasCompletedReturn]
 * @property {boolean|undefined} [isPartiallyReturned]
 * @property {boolean|undefined} [isFullyCancelled]
 * @property {boolean|undefined} [isPartiallyCancelled]
 */

/**
 * @typedef {object} OrderPresentationSecondary
 * @property {string} key
 * @property {string} label
 */

/**
 * @typedef {object} OrderPresentation
 * @property {string} key
 * @property {string} label
 * @property {string} customerLabel
 * @property {string} adminLabel
 * @property {string} category
 * @property {'neutral'|'info'|'success'|'warning'|'danger'} tone
 * @property {string[]} sources
 * @property {OrderPresentationSecondary|null} [payment]
 * @property {OrderPresentationSecondary|null} [return]
 */

function upper(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase();
}

function hasValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * Payment as secondary chip only (except FAILED which can be primary).
 * PAID → no payment badge.
 *
 * @param {string|null|undefined} paymentStatus
 * @returns {OrderPresentationSecondary|null}
 */
export function deriveOrderPaymentPresentation(paymentStatus) {
  const p = upper(paymentStatus);
  if (p === 'PARTIALLY_REFUNDED') {
    return { key: 'partially_refunded', label: 'Partially refunded' };
  }
  if (p === 'REFUNDED') {
    return { key: 'refunded', label: 'Refunded' };
  }
  if (p === 'FAILED') {
    return { key: 'payment_failed', label: 'Payment failed' };
  }
  return null;
}

/**
 * @param {OrderPresentationInput} order
 * @returns {OrderPresentationSecondary|null}
 */
function deriveReturnSecondary(order) {
  if (order.fullReturnLabel) return null;
  if (order.isPartiallyReturned) {
    return { key: 'partial_return', label: 'Partial return' };
  }
  if (order.hasActiveReturn) {
    return { key: 'return_in_progress', label: 'Return in progress' };
  }
  if (order.hasCompletedReturn) {
    return { key: 'return_completed', label: 'Return completed' };
  }
  return null;
}

/**
 * Physical shipment evidence — label/tracking alone do NOT count.
 * @param {OrderPresentationInput} order
 */
function isPhysicallyShipped(order) {
  const fs = upper(order.fulfillmentStatus);
  if (['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(fs)) {
    return true;
  }
  if (hasValue(order.outboundShippedAt)) return true;
  const st = upper(order.status);
  if (!hasValue(order.fulfillmentStatus) && (st === 'SHIPPED' || st.includes('SHIP'))) {
    return true;
  }
  return false;
}

/**
 * @param {OrderPresentationInput} order
 */
function isDeliveredPresentation(order) {
  const fs = upper(order.fulfillmentStatus);
  if (fs === 'DELIVERED') return true;
  if (hasValue(order.deliveredAt)) return true;
  const st = upper(order.status);
  if (st === 'DELIVERED' || st.includes('DELIVER')) return true;
  return false;
}

/**
 * @param {OrderPresentationInput} order
 */
function isPaid(order) {
  return upper(order.paymentStatus) === 'PAID';
}

/** Paid or partially refunded — still show warehouse/fulfillment progress. */
function hasFulfillmentPayment(order) {
  const p = upper(order.paymentStatus);
  return p === 'PAID' || p === 'PARTIALLY_REFUNDED';
}

/**
 * @param {OrderPresentationInput} order
 */
function isUnpaidOrPendingPayment(order) {
  const p = upper(order.paymentStatus);
  return !p || p === 'PENDING' || p === 'UNPAID' || p === 'REQUIRES_PAYMENT';
}

/**
 * @param {string} key
 * @param {string} customerLabel
 * @param {string} adminLabel
 * @param {string} category
 * @param {OrderPresentation['tone']} tone
 * @param {string[]} sources
 * @returns {OrderPresentation}
 */
function result(key, customerLabel, adminLabel, category, tone, sources) {
  return {
    key,
    label: customerLabel,
    customerLabel,
    adminLabel,
    category,
    tone,
    sources,
    payment: null,
    return: null,
  };
}

/**
 * Derive human-readable order presentation from authority fields.
 * Does not mutate `order`.
 *
 * @param {OrderPresentationInput} order
 * @returns {OrderPresentation}
 */
export function deriveOrderPresentation(order = {}) {
  const status = upper(order.status);
  const paymentStatus = upper(order.paymentStatus);
  const fulfillment = upper(order.fulfillmentStatus);
  const paymentSecondary = deriveOrderPaymentPresentation(order.paymentStatus);
  const returnSecondary = deriveReturnSecondary(order);

  // 1. Full cancelled
  if (status === 'CANCELLED' || order.isFullyCancelled === true) {
    return {
      ...result('cancelled', 'Cancelled', 'Cancelled', 'cancelled', 'danger', ['status']),
      payment:
        paymentStatus === 'REFUNDED' || paymentStatus === 'PARTIALLY_REFUNDED'
          ? paymentSecondary
          : paymentStatus === 'FAILED'
            ? paymentSecondary
            : null,
      return: returnSecondary,
    };
  }

  // 2. Refunded for non-cancelled order
  if (status === 'REFUNDED' || paymentStatus === 'REFUNDED') {
    return {
      ...result('refunded', 'Refunded', 'Refunded', 'refunded', 'danger', [
        status === 'REFUNDED' ? 'status' : 'paymentStatus',
      ]),
      payment: null,
      return: returnSecondary,
    };
  }

  // 3. Active/full return presentation where currently supported
  if (order.fullReturnLabel) {
    return {
      ...result(
        'returned',
        order.fullReturnLabel,
        order.fullReturnLabel,
        'returned',
        'warning',
        ['return']
      ),
      payment: paymentSecondary,
      return: null,
    };
  }
  if (status === 'RETURNED') {
    return {
      ...result('returned', 'Returned', 'Returned', 'returned', 'warning', ['status']),
      payment: paymentSecondary,
      return: null,
    };
  }

  // 4. Delivered
  if (isDeliveredPresentation(order)) {
    return {
      ...result('delivered', 'Delivered', 'Delivered', 'delivered', 'success', [
        hasValue(order.deliveredAt)
          ? 'deliveredAt'
          : fulfillment === 'DELIVERED'
            ? 'fulfillmentStatus'
            : 'status',
      ]),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }

  // 5–7. Carrier progress (fulfillment authority). Label/tracking alone never imply SHIPPED.
  if (fulfillment === 'OUT_FOR_DELIVERY') {
    return {
      ...result(
        'out_for_delivery',
        'Out for delivery',
        'Out for delivery',
        'shipped',
        'info',
        ['fulfillmentStatus']
      ),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }
  if (fulfillment === 'IN_TRANSIT') {
    return {
      ...result('in_transit', 'In transit', 'In transit', 'shipped', 'info', ['fulfillmentStatus']),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }
  if (fulfillment === 'SHIPPED') {
    const trackingHint = upper(order.trackingStatus);
    if (trackingHint.includes('OUT FOR DELIVERY') || trackingHint.includes('OUT_FOR_DELIVERY')) {
      return {
        ...result(
          'out_for_delivery',
          'Out for delivery',
          'Out for delivery',
          'shipped',
          'info',
          ['fulfillmentStatus', 'trackingStatus']
        ),
        payment: paymentSecondary,
        return: returnSecondary,
      };
    }
    return {
      ...result('shipped', 'Shipped', 'Shipped', 'shipped', 'info', ['fulfillmentStatus']),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }

  // Historical: status=SHIPPED + null fulfillment → Shipped
  if (!hasValue(order.fulfillmentStatus) && isPhysicallyShipped(order)) {
    const trackingHint = upper(order.trackingStatus);
    if (trackingHint.includes('DELIVER') && !trackingHint.includes('UNDELIVER')) {
      return {
        ...result(
          'out_for_delivery',
          'Out for delivery',
          'Out for delivery',
          'shipped',
          'info',
          ['status', 'trackingStatus']
        ),
        payment: paymentSecondary,
        return: returnSecondary,
      };
    }
    return {
      ...result('shipped', 'Shipped', 'Shipped', 'shipped', 'info', [
        hasValue(order.outboundShippedAt) ? 'outboundShippedAt' : 'status',
      ]),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }

  // 8–9. Pre-ship warehouse states — label/tracking must NOT become Shipped
  if (hasFulfillmentPayment(order) && fulfillment === 'PICKUP_READY') {
    return {
      ...result(
        'pickup_ready',
        'Preparing to ship',
        'Ready to ship',
        'processing',
        'info',
        ['paymentStatus', 'fulfillmentStatus']
      ),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }
  if (hasFulfillmentPayment(order) && fulfillment === 'LABEL_GENERATED') {
    return {
      ...result(
        'label_generated',
        'Preparing to ship',
        'Ready to ship',
        'processing',
        'info',
        ['paymentStatus', 'fulfillmentStatus']
      ),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }
  if (
    hasFulfillmentPayment(order) &&
    (fulfillment === 'ACCEPTED' || fulfillment === 'NEW_ORDER')
  ) {
    const items = Array.isArray(order.orderItems) ? order.orderItems : [];
    const started = items.some((li) => Number(li?.pickedQuantity || 0) > 0);
    if (started) {
      return {
        ...result(
          'in_process',
          'Preparing to ship',
          'In process',
          'processing',
          'info',
          ['paymentStatus', 'fulfillmentStatus', 'orderItems']
        ),
        payment: paymentSecondary,
        return: returnSecondary,
      };
    }
    return {
      ...result(
        fulfillment === 'NEW_ORDER' ? 'new_order' : 'accepted',
        'Preparing to ship',
        'New',
        'processing',
        'info',
        ['paymentStatus', 'fulfillmentStatus']
      ),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }

  // 10. Payment failed
  if (paymentStatus === 'FAILED') {
    return {
      ...result('payment_failed', 'Payment failed', 'Payment failed', 'payment_failed', 'danger', [
        'paymentStatus',
      ]),
      payment: null,
      return: returnSecondary,
    };
  }

  // 11. Unpaid / PENDING payment
  if (isUnpaidOrPendingPayment(order)) {
    return {
      ...result(
        'pending',
        'Pending',
        'Payment pending',
        'pending',
        'warning',
        ['paymentStatus']
      ),
      payment: null,
      return: returnSecondary,
    };
  }

  if (status === 'PENDING' && !isPaid(order)) {
    return {
      ...result('pending', 'Pending', 'Payment pending', 'pending', 'warning', ['status']),
      payment: null,
      return: returnSecondary,
    };
  }

  // 12. Historical fallbacks
  if (status === 'CONFIRMED') {
    return {
      ...result('processing', 'Processing', 'Processing', 'processing', 'info', ['status']),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }

  if (hasFulfillmentPayment(order) && (status === 'PROCESSING' || !hasValue(order.fulfillmentStatus))) {
    return {
      ...result('preparing', 'Preparing to ship', 'Processing', 'processing', 'info', [
        'paymentStatus',
        hasValue(order.fulfillmentStatus) ? 'status' : 'fulfillmentStatus',
      ]),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }

  if (status === 'PROCESSING') {
    return {
      ...result('processing', 'Processing', 'Processing', 'processing', 'info', ['status']),
      payment: paymentSecondary,
      return: returnSecondary,
    };
  }

  const fallbackLabel = hasValue(order.status)
    ? String(order.status).replace(/_/g, ' ')
    : 'Pending';
  return {
    ...result('unknown', fallbackLabel, fallbackLabel, 'pending', 'neutral', ['status']),
    payment: paymentSecondary,
    return: returnSecondary,
  };
}
