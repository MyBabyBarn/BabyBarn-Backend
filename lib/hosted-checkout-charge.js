import { usdToCents } from './order-refund-balance.js';

function pushFlatLine(lineItems, cents, name) {
  const unitAmount = Math.round(Number(cents) || 0);
  if (unitAmount <= 0) return;
  lineItems.push({
    quantity: 1,
    price_data: {
      currency: 'usd',
      unit_amount: unitAmount,
      product_data: { name },
    },
  });
}

export function sumHostedLineItemsCents(lineItems) {
  return (lineItems || []).reduce((sum, item) => {
    const unit = Math.round(Number(item?.price_data?.unit_amount) || 0);
    const quantity = Math.round(Number(item?.quantity) || 0);
    return sum + unit * quantity;
  }, 0);
}

/**
 * Hosted Checkout must charge the checkout-intent total: items, shipping, tax,
 * and membership, minus store credit. Stripe line items cannot be negative, so
 * store credit is returned separately for a one-time amount_off coupon.
 * The returned charge always nets to the intent total in cents.
 */
export function buildHostedCheckoutCharge(intent) {
  const lineItems = [];
  for (const line of intent?.lines || []) {
    const unitAmount = usdToCents(line.price);
    const quantity = Math.round(Number(line.quantity) || 0);
    if (unitAmount <= 0 || quantity <= 0) continue;
    lineItems.push({
      quantity,
      price_data: {
        currency: 'usd',
        unit_amount: unitAmount,
        product_data: { name: line.product?.name || 'Item' },
      },
    });
  }

  pushFlatLine(lineItems, usdToCents(intent?.shippingCost), 'Shipping');
  pushFlatLine(lineItems, usdToCents(intent?.taxAmount), 'Sales tax');
  if (intent?.includeAccessMembership) {
    pushFlatLine(
      lineItems,
      usdToCents(intent.accessMembershipAmount),
      'Baby Barn Farmhouse Friends (1 year)'
    );
  }

  const expectedCents = usdToCents(intent?.totalAmount);
  let storeCreditCents = Math.min(
    Math.max(0, usdToCents(intent?.storeCreditApplied)),
    sumHostedLineItemsCents(lineItems)
  );
  let netCents = sumHostedLineItemsCents(lineItems) - storeCreditCents;

  if (netCents < expectedCents) {
    pushFlatLine(lineItems, expectedCents - netCents, 'Checkout adjustment');
    netCents = expectedCents;
  } else if (netCents > expectedCents) {
    storeCreditCents += netCents - expectedCents;
    netCents = expectedCents;
  }

  return {
    lineItems,
    storeCreditCents,
    expectedCents,
    chargedCents: netCents,
  };
}

/** True only when Stripe's received cents equal the server checkout total. */
export function checkoutAmountMatches(amountReceivedCents, expectedCents) {
  return (
    Number.isInteger(amountReceivedCents) &&
    Number.isInteger(expectedCents) &&
    amountReceivedCents === expectedCents
  );
}
