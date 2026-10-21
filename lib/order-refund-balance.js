/**
 * Shared order refund balance helpers (return refunds + admin order refunds).
 *
 * Authoritative remaining capacity comes from Stripe charge amounts when available.
 * Local `order.totalAmount` is a secondary ledger cap (kept in sync by cancel,
 * return refunds, and admin order refunds).
 *
 * Admin "full order refund" means refund the *remaining* refundable balance
 * (current ledger/Stripe remaining), not the original paid amount.
 */

export const REFUNDABLE_PAYMENT_STATUSES = Object.freeze(['PAID', 'PARTIALLY_REFUNDED']);

export function moneyRound(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

export function usdToCents(usd) {
  return Math.round(moneyRound(usd) * 100);
}

export function centsToUsd(cents) {
  return moneyRound(Number(cents || 0) / 100);
}

/**
 * Whether an order payment status may accept additional card refunds.
 * Final authority still requires remaining refundable amount > 0.
 */
export function isRefundablePaymentStatus(paymentStatus) {
  return REFUNDABLE_PAYMENT_STATUSES.includes(String(paymentStatus || '').toUpperCase());
}

/**
 * Derive OrderPaymentStatus from paid vs already-refunded totals (cents).
 * Shipping retained after merchandise returns correctly yields PARTIALLY_REFUNDED.
 */
export function derivePaymentStatusFromRefundTotals(amountPaidCents, amountRefundedCents) {
  const paid = Math.max(0, Math.trunc(Number(amountPaidCents) || 0));
  const refunded = Math.max(0, Math.trunc(Number(amountRefundedCents) || 0));
  if (paid <= 0) {
    return refunded > 0 ? 'REFUNDED' : 'UNPAID';
  }
  if (refunded <= 0) return 'PAID';
  if (refunded >= paid) return 'REFUNDED';
  return 'PARTIALLY_REFUNDED';
}

/**
 * Cap a requested refund against remaining capacity.
 * Returns { ok, remainingCents, requestedCents } — ok false when requested exceeds remaining.
 */
export function assertRefundWithinRemaining(requestedCents, remainingCents) {
  const requested = Math.max(0, Math.trunc(Number(requestedCents) || 0));
  const remaining = Math.max(0, Math.trunc(Number(remainingCents) || 0));
  if (requested < 1) {
    return {
      ok: false,
      code: 'REFUND_AMOUNT_INVALID',
      message: 'Refund amount must be greater than zero',
      requestedCents: requested,
      remainingCents: remaining,
    };
  }
  if (requested > remaining) {
    return {
      ok: false,
      code: 'REFUND_EXCEEDS_REMAINING',
      message: `Refund exceeds remaining refundable balance (requested $${centsToUsd(requested).toFixed(2)}, remaining $${centsToUsd(remaining).toFixed(2)})`,
      requestedCents: requested,
      remainingCents: remaining,
    };
  }
  return {
    ok: true,
    requestedCents: requested,
    remainingCents: remaining,
  };
}

/**
 * Local remaining refundable USD from order ledger.
 * Cancel path reduces totalAmount when refunding; return refunds should do the same.
 */
export function localRemainingRefundableUsd(order) {
  return moneyRound(Math.max(0, Number(order?.totalAmount ?? 0)));
}

/**
 * Sum already-recorded standard return refunds for an order (local ledger).
 * Does not include cancel/admin refunds (those reduce totalAmount / appear on Stripe).
 */
export function sumRecordedReturnRefundsUsd(returnRows) {
  if (!Array.isArray(returnRows) || !returnRows.length) return 0;
  return moneyRound(
    returnRows.reduce((sum, row) => {
      if (!row?.stripeRefundId && !row?.refundedAt) return sum;
      return sum + Math.max(0, Number(row.refundAmount ?? 0));
    }, 0)
  );
}

/**
 * Effective remaining cents = min(Stripe remaining, local totalAmount cents).
 * When Stripe balance is unavailable, fall back to local ledger only.
 */
export function resolveRemainingRefundableCents({ stripeRemainingCents, localRemainingUsd }) {
  const localCents = usdToCents(localRemainingUsd);
  if (stripeRemainingCents == null || !Number.isFinite(Number(stripeRemainingCents))) {
    return localCents;
  }
  return Math.max(0, Math.min(Math.trunc(Number(stripeRemainingCents)), localCents));
}

/**
 * Read paid / refunded / remaining from a Stripe PaymentIntent (expanded latest_charge preferred).
 */
export function extractStripeRefundBalance(paymentIntent) {
  if (!paymentIntent) {
    return { amountPaidCents: 0, amountRefundedCents: 0, remainingCents: 0 };
  }

  const charge =
    typeof paymentIntent.latest_charge === 'object' && paymentIntent.latest_charge
      ? paymentIntent.latest_charge
      : null;

  const amountPaidCents = Math.max(
    0,
    Math.trunc(
      Number(
        charge?.amount ??
          paymentIntent.amount_received ??
          paymentIntent.amount ??
          0
      ) || 0
    )
  );

  const amountRefundedCents = Math.max(
    0,
    Math.trunc(Number(charge?.amount_refunded ?? paymentIntent.amount_refunded ?? 0) || 0)
  );

  return {
    amountPaidCents,
    amountRefundedCents,
    remainingCents: Math.max(0, amountPaidCents - amountRefundedCents),
  };
}

/**
 * Fetch Stripe refund balance for a PaymentIntent id.
 */
export async function fetchStripeRefundBalance(stripe, paymentIntentId) {
  if (!stripe || !paymentIntentId) {
    return null;
  }
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge'],
  });
  return extractStripeRefundBalance(pi);
}

/**
 * Resolve admin order-refund amount.
 * Default (no explicit amount) = remaining refundable balance (not original order total).
 * Explicit amount must be <= remaining.
 */
export function resolveAdminOrderRefundRequest({ remainingCents, requestedAmountUsd = null }) {
  const remaining = Math.max(0, Math.trunc(Number(remainingCents) || 0));
  if (remaining < 1) {
    return {
      ok: false,
      code: 'ORDER_ALREADY_REFUNDED',
      message: 'Order has no remaining refundable balance',
      requestedCents: 0,
      remainingCents: remaining,
    };
  }

  const hasExplicit =
    requestedAmountUsd != null &&
    requestedAmountUsd !== '' &&
    Number.isFinite(Number(requestedAmountUsd));

  const requestedCents = hasExplicit ? usdToCents(requestedAmountUsd) : remaining;
  const within = assertRefundWithinRemaining(requestedCents, remaining);
  if (!within.ok) {
    return within;
  }

  return {
    ok: true,
    requestedCents: within.requestedCents,
    remainingCents: remaining,
    refundAmountUsd: centsToUsd(within.requestedCents),
    isFullRemaining: within.requestedCents === remaining,
  };
}

/** Map common Stripe refund failures to AppError-friendly codes/messages. */
export function classifyStripeRefundError(err) {
  const code = err?.code || err?.raw?.code;
  const message = String(err?.message || err?.raw?.message || '');
  if (
    code === 'charge_already_refunded' ||
    code === 'amount_too_large' ||
    /has already been refunded/i.test(message) ||
    /Refund amount \(\$?[\d.]+\) is greater than/i.test(message) ||
    /amount.*greater than.*charge/i.test(message)
  ) {
    return {
      code: 'REFUND_EXCEEDS_REMAINING',
      message: 'Refund exceeds remaining refundable balance on this payment',
    };
  }
  return null;
}
