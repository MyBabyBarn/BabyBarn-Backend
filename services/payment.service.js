import Stripe from 'stripe';
import { prisma, refreshPrismaClientIfNeeded } from '../lib/prisma.js';
import { config } from '../config/env.js';
import { AppError } from '../utils/error-handler.js';
import { orderService } from './order.service.js';
import { checkoutIntentService } from './checkout-intent.service.js';
import { emailService } from './email.service.js';
import { buildOrderTrackingUrl, buildGuestReturnUrl } from '../lib/order-tracking-token.js';
import { notifyNewPaidOrder } from './admin-notification.service.js';
import {
  beginStripeWebhookEvent,
  finishStripeWebhookEvent,
} from '../lib/stripe-webhook-idempotency.js';
import {
  derivePaymentStatusFromRefundTotals,
  moneyRound,
  usdToCents,
} from '../lib/order-refund-balance.js';
import {
  buildHostedCheckoutCharge,
  checkoutAmountMatches,
} from '../lib/hosted-checkout-charge.js';
import {
  recordOpenPaymentReconciliation,
  resolveOpenPaymentReconciliations,
} from '../lib/payment-reconciliation.js';

async function getMembershipUnitAmountCents() {
  try {
    const row = await prisma.businessSettings.findUnique({ where: { id: 1 } });
    const usd = row?.accessMembershipPriceUsd ?? 50;
    return Math.round(Number(usd) * 100);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && (e.code === 'P2021' || e.code === 'P2022')) {
      return Math.round(50 * 100);
    }
    throw e;
  }
}

/** Same-origin path only (query/hash stripped). Used for post–ACCESS-checkout redirect. */
function normalizeStoreReturnPath(returnTo) {
  if (returnTo == null || typeof returnTo !== 'string') return null;
  const raw = returnTo.trim().split('#')[0].split('?')[0];
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  if (raw.includes('://') || raw.includes('..') || raw.includes('@')) return null;
  if (raw.length > 200) return null;
  return raw;
}

let stripeClient = null;

export function getStripe() {
  if (!config.stripe.secretKey) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(config.stripe.secretKey);
  }
  return stripeClient;
}

function hasValidConnectAccountId(value) {
  return typeof value === 'string' && /^acct_[A-Za-z0-9]+$/.test(value.trim());
}

function toStripeAppError(error, code, flow = 'order') {
  if (error instanceof AppError) return error;
  const stripeCode = error?.code ? String(error.code) : '';
  const stripeType = error?.type ? String(error.type) : '';
  const message = error?.message ? String(error.message) : 'Stripe request failed';
  console.error(`[payments] ${flow} stripe error`, { stripeCode, stripeType, message });
  return new AppError(502, message, code, {
    stripeCode: stripeCode || null,
    stripeType: stripeType || null,
    flow,
  });
}

async function ensureCheckoutPaymentIntent(stripe, checkoutIntent, user, opts = {}) {
  const refreshed = await prisma.checkoutIntent.findUnique({
    where: { id: checkoutIntent.id },
    select: {
      totalAmount: true,
      publicId: true,
      stripePaymentIntentId: true,
      includeAccessMembership: true,
      accessMembershipAmount: true,
      contactEmail: true,
    },
  });
  const checkoutIntentPublicId = refreshed?.publicId ?? checkoutIntent.publicId;
  const payable = Number(refreshed?.totalAmount ?? checkoutIntent.totalAmount);
  const amountCents = Math.round(payable * 100);
  // ORD-03: fully store-credit-covered checkouts complete without a Stripe charge.
  if (amountCents === 0) {
    const order = await checkoutIntentService.createPaidOrderFromCheckoutIntent(checkoutIntentPublicId, {
      paymentSucceeded: true,
      amountReceivedCents: 0,
    });
    return {
      zeroCharge: true,
      clientSecret: null,
      paymentIntentId: null,
      checkoutIntentPublicId,
      orderPublicId: order?.publicId ?? null,
      amountCents: 0,
    };
  }
  if (amountCents > 0 && amountCents < 50) {
    throw new AppError(400, 'Order total is below the minimum charge amount', 'ORDER_TOTAL_TOO_LOW');
  }
  const includeAccessMembership = Boolean(
    refreshed?.includeAccessMembership ?? checkoutIntent.includeAccessMembership
  );
  const membershipAmount = Number(
    refreshed?.accessMembershipAmount ?? checkoutIntent.accessMembershipAmount ?? 0
  );
  // Bundled orders (products + ACCESS membership) are charged on the platform and
  // split afterwards via Stripe transfers, so the membership fee reaches the dedicated
  // membership account instead of the store account.
  const splitTransfers = includeAccessMembership && membershipAmount > 0;
  const basePayload = {
    amount: amountCents,
    currency: 'usd',
    payment_method_types: ['card'],
    receipt_email: refreshed?.contactEmail || checkoutIntent.contactEmail || user.email || undefined,
    metadata: {
      flow: 'order',
      checkoutIntentPublicId,
      includeAccessMembership: includeAccessMembership ? 'true' : 'false',
      ...(splitTransfers
        ? { splitTransfers: 'true', membershipAmountCents: String(Math.round(membershipAmount * 100)) }
        : {}),
    },
    ...(splitTransfers ? { transfer_group: checkoutIntentPublicId } : {}),
    ...(opts.saveCard ? { setup_future_usage: 'off_session' } : {}),
  };

  const reusableStatuses = new Set([
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
  ]);

  const existingId = refreshed?.stripePaymentIntentId;
  if (existingId) {
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(existingId);
    } catch (retrieveErr) {
      console.warn('[payments] could not retrieve existing payment intent', existingId, retrieveErr?.message);
      paymentIntent = null;
    }

    if (paymentIntent?.status === 'succeeded') {
      throw new AppError(409, 'This checkout was already paid', 'ORDER_ALREADY_PAID');
    }

    if (
      paymentIntent &&
      paymentIntent.status !== 'canceled' &&
      reusableStatuses.has(paymentIntent.status)
    ) {
      if (paymentIntent.amount !== amountCents) {
        try {
          paymentIntent = await stripe.paymentIntents.update(existingId, { amount: amountCents });
        } catch (updateErr) {
          throw toStripeAppError(updateErr, 'STRIPE_PAYMENT_INTENT_FAILED', 'order');
        }
      }
      if (paymentIntent.client_secret) {
        return {
          clientSecret: paymentIntent.client_secret,
          checkoutIntentId: checkoutIntentPublicId,
          paymentIntentId: paymentIntent.id,
        };
      }
    }
  }

  let paymentIntent;
  try {
    paymentIntent = splitTransfers
      ? // Charge on the platform; funds are split to the membership/store accounts
        // via transfers once the payment succeeds (see applyOrderTransferSplit).
        await stripe.paymentIntents.create(basePayload)
      : await createPaymentIntentWithOptionalTransfer(stripe, basePayload, config.stripe.connectStore);
  } catch (error) {
    throw toStripeAppError(error, 'STRIPE_PAYMENT_INTENT_FAILED', 'order');
  }

  await prisma.checkoutIntent.update({
    where: { id: checkoutIntent.id },
    data: { stripePaymentIntentId: paymentIntent.id },
  });

  if (!paymentIntent.client_secret) {
    throw new AppError(502, 'Stripe did not return a payment client secret', 'STRIPE_PAYMENT_INTENT_FAILED');
  }

  return {
    clientSecret: paymentIntent.client_secret,
    checkoutIntentId: checkoutIntentPublicId,
    paymentIntentId: paymentIntent.id,
  };
}

async function createPaymentIntentWithOptionalTransfer(stripe, basePayload, destinationAccount) {
  const hasDestination = hasValidConnectAccountId(destinationAccount);
  const payload = hasDestination
    ? {
        ...basePayload,
        transfer_data: { destination: destinationAccount.trim() },
      }
    : basePayload;

  try {
    return await stripe.paymentIntents.create(payload);
  } catch (error) {
    const stripeCode = error?.code ? String(error.code) : '';
    const rawMessage = error?.message ? String(error.message) : '';
    const lower = rawMessage.toLowerCase();
    const connectDestinationProblem =
      hasDestination &&
      (stripeCode === 'resource_missing' ||
        stripeCode === 'account_invalid' ||
        lower.includes('transfer_data[destination]') ||
        lower.includes('no such destination') ||
        lower.includes('connected account'));

    if (connectDestinationProblem) {
      console.warn('[payments] order payment intent fallback without transfer_data', {
        destinationAccount,
        stripeCode,
      });
      return stripe.paymentIntents.create(basePayload);
    }
    throw error;
  }
}

/**
 * Split a bundled order charge between the membership and store Connect accounts.
 * The membership fee goes to the dedicated membership account; the remainder
 * (products + shipping + tax) goes to the store account. Uses `source_transaction`
 * so transfers draw from the specific charge, and per-leg idempotency keys so
 * duplicate webhooks never double-transfer.
 */
async function applyOrderTransferSplit(stripe, { chargeId, checkoutIntentPublicId, totalCents, membershipCents }) {
  if (!chargeId || !checkoutIntentPublicId) return;
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  const membership = Math.min(Math.max(0, Math.round(Number(membershipCents) || 0)), total);
  const store = Math.max(0, total - membership);

  const transferLeg = async (destinationAccount, amountCents, leg) => {
    if (amountCents <= 0) return;
    if (!hasValidConnectAccountId(destinationAccount)) {
      console.warn('[payments] skipping transfer leg — destination not configured', {
        leg,
        checkoutIntentPublicId,
      });
      return;
    }
    try {
      await stripe.transfers.create(
        {
          amount: amountCents,
          currency: 'usd',
          destination: destinationAccount.trim(),
          source_transaction: chargeId,
          transfer_group: checkoutIntentPublicId,
          metadata: { flow: 'order', checkoutIntentPublicId, leg },
        },
        { idempotencyKey: `${checkoutIntentPublicId}:${leg}` }
      );
    } catch (error) {
      console.error('[payments] order transfer split failed', {
        leg,
        destinationAccount,
        checkoutIntentPublicId,
        message: error?.message,
      });
    }
  };

  await transferLeg(config.stripe.connectMembership, membership, 'membership');
  await transferLeg(config.stripe.connectStore, store, 'store');
}

/**
 * After a bundled order is paid, split the charge across the membership and store
 * accounts. Resolves the charge id and membership amount from the PaymentIntent
 * metadata, falling back to the persisted checkout intent. No-op for non-bundled orders.
 */
async function splitOrderTransfersIfBundled(stripe, checkoutIntentPublicId, paymentIntentOrId) {
  if (!stripe || !checkoutIntentPublicId || !paymentIntentOrId) return;

  let paymentIntent =
    typeof paymentIntentOrId === 'string' ? null : paymentIntentOrId;
  const paymentIntentId =
    typeof paymentIntentOrId === 'string' ? paymentIntentOrId : paymentIntentOrId.id;

  if (!paymentIntent && paymentIntentId) {
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (error) {
      console.error('[payments] could not retrieve PI for transfer split', paymentIntentId, error?.message);
      return;
    }
  }
  if (!paymentIntent) return;

  let bundled = paymentIntent.metadata?.splitTransfers === 'true';
  let membershipCents = Number(paymentIntent.metadata?.membershipAmountCents || 0);
  if (!bundled || membershipCents <= 0) {
    const ci = await prisma.checkoutIntent.findUnique({
      where: { publicId: checkoutIntentPublicId },
      select: { includeAccessMembership: true, accessMembershipAmount: true },
    });
    bundled = Boolean(ci?.includeAccessMembership) && Number(ci?.accessMembershipAmount) > 0;
    membershipCents = bundled ? Math.round(Number(ci.accessMembershipAmount) * 100) : 0;
  }
  if (!bundled || membershipCents <= 0) return;

  let chargeId =
    typeof paymentIntent.latest_charge === 'string'
      ? paymentIntent.latest_charge
      : paymentIntent.latest_charge?.id || null;
  if (!chargeId) {
    try {
      const charges = await stripe.charges.list({ payment_intent: paymentIntent.id, limit: 1 });
      chargeId = charges?.data?.[0]?.id || null;
    } catch {
      chargeId = null;
    }
  }
  if (!chargeId) {
    console.error('[payments] cannot split transfers: no charge for PI', paymentIntent.id);
    return;
  }

  const totalCents = Number(paymentIntent.amount_received || paymentIntent.amount || 0);
  await applyOrderTransferSplit(stripe, {
    chargeId,
    checkoutIntentPublicId,
    totalCents,
    membershipCents,
  });
}

/**
 * Reverse split transfers for a refunded charge. Reversals are proportional to the
 * cumulative refunded amount: a full refund fully reverses each leg, a partial refund
 * reverses the matching share. Idempotency keys are derived from the target cumulative
 * reversal so repeated/partial refund events never over-reverse.
 */
async function reverseOrderTransfersForCharge(stripe, charge) {
  const transferGroup = charge?.transfer_group;
  if (!transferGroup) return;
  const chargeAmount = Number(charge.amount || 0);
  const refunded = Number(charge.amount_refunded || 0);
  if (chargeAmount <= 0 || refunded <= 0) return;

  let transfers;
  try {
    transfers = await stripe.transfers.list({ transfer_group: transferGroup, limit: 100 });
  } catch (error) {
    console.error('[payments] could not list transfers for reversal', transferGroup, error?.message);
    return;
  }

  for (const transfer of transfers?.data || []) {
    const targetReversed = Math.min(
      transfer.amount,
      Math.round((transfer.amount * refunded) / chargeAmount)
    );
    const alreadyReversed = Number(transfer.amount_reversed || 0);
    const delta = targetReversed - alreadyReversed;
    if (delta <= 0) continue;
    try {
      await stripe.transfers.createReversal(
        transfer.id,
        { amount: delta, metadata: { reason: 'charge.refunded', transferGroup } },
        { idempotencyKey: `${transfer.id}:reversal:${targetReversed}` }
      );
    } catch (error) {
      console.error('[payments] transfer reversal failed', transfer.id, error?.message);
    }
  }
}

function getFlow(metadata) {
  return metadata && typeof metadata.flow === 'string' ? metadata.flow : null;
}

function getOrderPublicId(metadata) {
  return metadata && typeof metadata.orderPublicId === 'string' ? metadata.orderPublicId : null;
}

function getCheckoutIntentPublicId(metadata) {
  return metadata && typeof metadata.checkoutIntentPublicId === 'string'
    ? metadata.checkoutIntentPublicId
    : null;
}

async function markOrderFailedIfUnpaid(orderPublicId, source) {
  if (!orderPublicId) return { handled: true, source, error: 'missing orderPublicId' };
  await orderService.releasePendingOrderResources(orderPublicId).catch((err) => {
    console.error('[payments] release pending resources failed', orderPublicId, err);
  });
  await prisma.order.updateMany({
    where: { publicId: orderPublicId, paymentStatus: 'UNPAID' },
    data: { paymentStatus: 'FAILED' },
  });
  return { handled: true, flow: 'order', source, orderPublicId };
}

/**
 * WS-A2: Sync order paymentStatus from Stripe charge refund totals.
 * Never full-restocks inventory from charge.refunded (partial refunds must not inflate stock).
 * PRODUCT DECISION REQUIRED for whether Stripe/Dashboard refunds should restock at all.
 */
async function markOrderRefundedBySessionId(sessionId, source) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { handled: true, source, error: 'missing sessionId' };
  }
  const order = await prisma.order.findFirst({
    where: {
      OR: [{ stripeCheckoutSessionId: sessionId }, { stripePaymentIntentId: sessionId }],
      paymentStatus: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
    },
    select: {
      id: true,
      publicId: true,
      totalAmount: true,
      paymentStatus: true,
      stripePaymentIntentId: true,
      stripeCheckoutSessionId: true,
    },
  });
  if (!order) {
    return { handled: true, flow: 'order', source, sessionId, error: 'order not found' };
  }

  const stripe = getStripe();
  let amountPaidCents = null;
  let amountRefundedCents = null;
  const paymentIntentId = order.stripePaymentIntentId;
  if (stripe && paymentIntentId) {
    try {
      const { fetchStripeRefundBalance } = await import('../lib/order-refund-balance.js');
      const balance = await fetchStripeRefundBalance(stripe, paymentIntentId);
      if (balance) {
        amountPaidCents = balance.amountPaidCents;
        amountRefundedCents = balance.amountRefundedCents;
      }
    } catch (err) {
      console.error('[payments] charge.refunded balance fetch failed', order.publicId, err?.message);
    }
  }

  if (amountPaidCents == null || amountRefundedCents == null) {
    // Cannot prove totals — do not restock; leave local ledger alone.
    return {
      handled: true,
      flow: 'order',
      source,
      sessionId,
      orderPublicId: order.publicId,
      inventory: 'unchanged',
      note: 'stripe_balance_unavailable',
    };
  }

  const paymentStatus = derivePaymentStatusFromRefundTotals(amountPaidCents, amountRefundedCents);
  if (paymentStatus === order.paymentStatus && paymentStatus !== 'REFUNDED') {
    return {
      handled: true,
      flow: 'order',
      source,
      sessionId,
      orderPublicId: order.publicId,
      paymentStatus,
      inventory: 'unchanged',
      note: 'already_synced',
    };
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus,
      refundedAmountCents: amountRefundedCents,
      ...(paymentStatus === 'REFUNDED' ? { status: 'REFUNDED' } : {}),
    },
  });

  return {
    handled: true,
    flow: 'order',
    source,
    sessionId,
    orderPublicId: order.publicId,
    paymentStatus,
    inventory: 'unchanged',
    note: 'payment_synced_no_restock',
  };
}


async function getCheckoutSessionIdFromPaymentIntent(stripe, paymentIntentId) {
  if (!paymentIntentId || typeof paymentIntentId !== 'string') return null;
  const sessions = await stripe.checkout.sessions.list({
    payment_intent: paymentIntentId,
    limit: 1,
  });
  return sessions?.data?.[0]?.id ?? null;
}

async function persistOrderPaymentIntent(orderPublicId, paymentIntentId) {
  if (!orderPublicId || !paymentIntentId) return;
  await prisma.order.updateMany({
    where: { publicId: orderPublicId },
    data: { stripePaymentIntentId: paymentIntentId },
  });
}

async function markCheckoutIntentFailed(checkoutIntentPublicId, source) {
  if (!checkoutIntentPublicId) {
    return { handled: true, source, error: 'missing checkoutIntentPublicId' };
  }
  await checkoutIntentService.releaseIntentResources(checkoutIntentPublicId).catch((err) => {
    console.error('[payments] release checkout intent failed', checkoutIntentPublicId, err);
  });
  await prisma.checkoutIntent.updateMany({
    where: { publicId: checkoutIntentPublicId, status: 'PENDING' },
    data: { status: 'FAILED' },
  });
  return { handled: true, flow: 'order', source, checkoutIntentPublicId };
}

async function markOrderFlowPaymentFailed(metadata, source) {
  const checkoutIntentPublicId = getCheckoutIntentPublicId(metadata);
  if (checkoutIntentPublicId) {
    return markCheckoutIntentFailed(checkoutIntentPublicId, source);
  }
  return markOrderFailedIfUnpaid(getOrderPublicId(metadata), source);
}

async function handleOrderCheckoutCompleted(session) {
  const checkoutIntentPublicId = getCheckoutIntentPublicId(session.metadata);
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;

  if (checkoutIntentPublicId) {
    if (paymentIntentId) {
      await prisma.checkoutIntent.updateMany({
        where: { publicId: checkoutIntentPublicId },
        data: { stripePaymentIntentId: paymentIntentId },
      });
    }
    const result = await handleCheckoutIntentPaymentCompleted(checkoutIntentPublicId, {
      paymentIntentId: paymentIntentId || undefined,
      amountReceivedCents: Number.isInteger(session.amount_total) ? session.amount_total : undefined,
    });
    if (result && typeof result === 'object' && result.orderPublicId) {
      await prisma.order.updateMany({
        where: { publicId: result.orderPublicId },
        data: {
          stripeCheckoutSessionId: session.id,
          ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
          paymentStatus: 'PAID',
        },
      });
    }
    if (paymentIntentId) {
      await splitOrderTransfersIfBundled(getStripe(), checkoutIntentPublicId, paymentIntentId);
    }
    return result;
  }

  const orderPublicId = getOrderPublicId(session.metadata);
  if (paymentIntentId) {
    await persistOrderPaymentIntent(orderPublicId, paymentIntentId);
  }
  return handleOrderPaymentCompleted(orderPublicId);
}

async function handleOrderPaymentIntentSucceeded(paymentIntent) {
  const flow = getFlow(paymentIntent.metadata);
  if (flow !== 'order') {
    return { handled: false, type: 'payment_intent.succeeded', flow };
  }
  const checkoutIntentPublicId = getCheckoutIntentPublicId(paymentIntent.metadata);
  if (checkoutIntentPublicId) {
    await prisma.checkoutIntent.updateMany({
      where: { publicId: checkoutIntentPublicId },
      data: { stripePaymentIntentId: paymentIntent.id },
    });
    const receivedCents = Number(paymentIntent.amount_received ?? paymentIntent.amount);
    const result = await handleCheckoutIntentPaymentCompleted(checkoutIntentPublicId, {
      paymentIntentId: paymentIntent.id,
      amountReceivedCents: Number.isInteger(receivedCents) ? receivedCents : undefined,
    });
    await splitOrderTransfersIfBundled(getStripe(), checkoutIntentPublicId, paymentIntent);
    return result;
  }
  return handleOrderPaymentCompleted(getOrderPublicId(paymentIntent.metadata));
}

/** Card-only — excludes Klarna, Affirm, and other Pay Later methods on Checkout. */
function cardOnlyCheckoutOptions() {
  return { payment_method_types: ['card'] };
}

async function createCheckoutSessionWithOptionalTransfer(stripe, basePayload, destinationAccount, flow) {
  const hasDestination = hasValidConnectAccountId(destinationAccount);
  const payload = hasDestination
    ? {
        ...basePayload,
        ...cardOnlyCheckoutOptions(),
        payment_intent_data: {
          ...(basePayload.payment_intent_data || {}),
          transfer_data: { destination: destinationAccount.trim() },
        },
      }
    : { ...basePayload, ...cardOnlyCheckoutOptions() };

  try {
    return await stripe.checkout.sessions.create(payload);
  } catch (error) {
    const stripeCode = error?.code ? String(error.code) : '';
    const stripeType = error?.type ? String(error.type) : '';
    const rawMessage = error?.message ? String(error.message) : 'Stripe checkout session creation failed';
    const lower = rawMessage.toLowerCase();
    const connectDestinationProblem =
      hasDestination &&
      (stripeCode === 'resource_missing' ||
        stripeCode === 'account_invalid' ||
        lower.includes('transfer_data[destination]') ||
        lower.includes('no such destination') ||
        lower.includes('connected account'));

    if (connectDestinationProblem) {
      const fallbackPayload = { ...basePayload };
      const retrySession = await stripe.checkout.sessions.create(fallbackPayload);
      console.warn(`[payments] ${flow} checkout fallback without transfer_data`, {
        destinationAccount,
        stripeCode,
        stripeType,
      });
      return retrySession;
    }

    throw new AppError(502, rawMessage, 'STRIPE_CHECKOUT_CREATE_FAILED', {
      stripeCode: stripeCode || null,
      stripeType: stripeType || null,
      flow,
    });
  }
}

function assertConnectAccountsForOrder() {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError(503, 'Payments are not configured (missing STRIPE_SECRET_KEY)');
  }
  return stripe;
}

function assertConnectAccountsForMembership() {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError(503, 'Payments are not configured (missing STRIPE_SECRET_KEY)');
  }
  return stripe;
}

export async function createMembershipCheckoutSession(userPublicId, opts = {}) {
  const stripe = assertConnectAccountsForMembership();

  const { assertMembershipCheckoutAllowed } = await import('./membership-eligibility.service.js');
  const checkoutEligibility = await assertMembershipCheckoutAllowed(userPublicId, {
    intent: opts.intent,
    returnTo: opts.returnTo,
  });

  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: {
      email: true,
      publicId: true,
      babyName: true,
      membershipShippingAddressJson: true,
    },
  });
  if (!user) {
    throw new AppError(401, 'Unauthorized');
  }

  if (opts.registration) {
    const { saveMembershipRegistration } = await import('./membership.service.js');
    await saveMembershipRegistration(userPublicId, opts.registration);
  } else if (!user.babyName || !user.membershipShippingAddressJson) {
    throw new AppError(
      400,
      'Complete ACCESS registration (baby name and shipping address) before checkout.'
    );
  }

  const returnPath = normalizeStoreReturnPath(opts.returnTo);
  const successBase = `${config.storeUrl}/access/success?session_id={CHECKOUT_SESSION_ID}`;
  const successUrl = returnPath
    ? `${successBase}&returnTo=${encodeURIComponent(returnPath)}`
    : successBase;
  const cancelUrl = returnPath
    ? `${config.storeUrl}${returnPath}?access_cancelled=1`
    : `${config.storeUrl}/access?cancelled=1`;

  const unitCents = await getMembershipUnitAmountCents();

  const session = await createCheckoutSessionWithOptionalTransfer(
    stripe,
    {
    mode: 'payment',
    customer_email: user.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: unitCents,
          product_data: {
            name: 'Farmhouse Friends',
            description: 'Baby Barn Farmhouse Friends member benefits',
          },
        },
      },
    ],
    metadata: {
      flow: 'membership',
      userPublicId: user.publicId,
      checkoutIntent: checkoutEligibility.checkoutIntent || 'purchase',
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
    },
    config.stripe.connectMembership,
    'membership'
  );

  return { url: session.url, sessionId: session.id };
}

export async function createOrderCheckoutSession(userPublicId, items, opts = {}) {
  const stripe = assertConnectAccountsForOrder();

  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: { email: true },
  });
  if (!user) {
    throw new AppError(401, 'Unauthorized');
  }

  const checkoutIntent = await checkoutIntentService.resolveCheckoutIntent(userPublicId, items, {
    shippingAddress: opts.shippingAddress,
    billingAddress: opts.billingAddress,
    parcels: opts.parcels,
    selectedRateId: opts.selectedRateId,
    selectedRate: opts.selectedRate,
    storeCreditToApply: opts.storeCreditToApply,
    checkoutIntentPublicId: opts.orderId,
    includeAccessMembership: opts.includeAccessMembership,
    membershipBabyName: opts.babyName,
    babyName: opts.babyName,
    contactEmail: opts.contactEmail,
    contactPhone: opts.contactPhone,
    sharedMembershipCode: opts.sharedMembershipCode,
  });

  const successUrl = `${config.storeUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${config.storeUrl}/checkout/error?reason=cancelled`;

  const charge = buildHostedCheckoutCharge(checkoutIntent);
  // ORD-03: credit-only hosted checkout — no Stripe session.
  if (charge.expectedCents === 0) {
    const order = await checkoutIntentService.createPaidOrderFromCheckoutIntent(checkoutIntent.publicId, {
      paymentSucceeded: true,
      amountReceivedCents: 0,
    });
    return {
      zeroCharge: true,
      url: null,
      sessionId: null,
      checkoutIntentPublicId: checkoutIntent.publicId,
      orderPublicId: order?.publicId ?? null,
    };
  }
  if (charge.expectedCents > 0 && charge.expectedCents < 50) {
    throw new AppError(400, 'Order total is below the minimum charge amount', 'ORDER_TOTAL_TOO_LOW');
  }
  const lineItems = charge.lineItems;
  let storeCreditDiscounts;
  if (charge.storeCreditCents > 0) {
    let coupon;
    try {
      coupon = await stripe.coupons.create({
        amount_off: charge.storeCreditCents,
        currency: 'usd',
        duration: 'once',
        name: 'Store credit',
        max_redemptions: 1,
      });
    } catch (error) {
      throw toStripeAppError(error, 'STRIPE_CHECKOUT_CREATE_FAILED', 'order');
    }
    storeCreditDiscounts = [{ coupon: coupon.id }];
  }

  // Bundled orders are charged on the platform and split via transfers afterwards, so
  // the membership fee reaches the membership account (see applyOrderTransferSplit).
  const splitTransfers =
    Boolean(checkoutIntent.includeAccessMembership) && Number(checkoutIntent.accessMembershipAmount) > 0;
  const membershipAmountCents = splitTransfers
    ? String(Math.round(Number(checkoutIntent.accessMembershipAmount) * 100))
    : null;

  const session = await createCheckoutSessionWithOptionalTransfer(
    stripe,
    {
    mode: 'payment',
    customer_email: user.email,
    customer_creation: 'always',
    line_items: lineItems,
    ...(storeCreditDiscounts ? { discounts: storeCreditDiscounts } : {}),
    metadata: {
      flow: 'order',
      checkoutIntentPublicId: checkoutIntent.publicId,
      includeAccessMembership: checkoutIntent.includeAccessMembership ? 'true' : 'false',
      ...(splitTransfers ? { splitTransfers: 'true', membershipAmountCents } : {}),
    },
    ...(splitTransfers
      ? {
          payment_intent_data: {
            transfer_group: checkoutIntent.publicId,
            metadata: {
              flow: 'order',
              checkoutIntentPublicId: checkoutIntent.publicId,
              splitTransfers: 'true',
              membershipAmountCents,
            },
          },
        }
      : {}),
    success_url: successUrl,
    cancel_url: cancelUrl,
    },
    // Skip the destination charge for bundled orders so funds land on the platform
    // and can be split between the membership and store accounts.
    splitTransfers ? null : config.stripe.connectStore,
    'order'
  );

  await prisma.checkoutIntent.update({
    where: { id: checkoutIntent.id },
    data: { stripePaymentIntentId: session.id },
  });

  return { url: session.url, sessionId: session.id, checkoutIntentId: checkoutIntent.publicId };
}

function formatEmailAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const lines = formatEmailAddressLines(addr);
  return lines.length ? lines.join('\n') : null;
}

function formatEmailAddressLines(addr, { name, email, phone } = {}) {
  const lines = [];
  const fromName =
    name ||
    [addr?.firstName, addr?.lastName].filter(Boolean).join(' ').trim() ||
    (typeof addr?.name === 'string' ? addr.name.trim() : '');
  if (fromName) lines.push(fromName);
  if (email) lines.push(email);
  if (phone) lines.push(phone);
  if (!addr || typeof addr !== 'object') return lines;
  for (const part of [
    addr.line1 || addr.address1 || addr.street,
    addr.line2 || addr.address2,
    [addr.city, addr.state, addr.postalCode || addr.zip].filter(Boolean).join(', '),
    addr.country,
  ]) {
    const text = typeof part === 'string' ? part.trim() : '';
    if (text && !lines.includes(text)) lines.push(text);
  }
  return lines;
}

function formatMoneyUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function titleCaseStatus(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/(^|[\s_-])(\w)/g, (_, sep, ch) => `${sep === '_' || sep === '-' ? ' ' : sep}${ch.toUpperCase()}`)
    .trim();
}

function formatOrderIssueDate(value) {
  if (!value) return null;
  try {
    return new Date(value).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return String(value);
  }
}

function formatVariantCombination(combination) {
  if (!combination || typeof combination !== 'object' || Array.isArray(combination)) return '';
  return Object.entries(combination)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

function orderLineEmailMeta(li) {
  const parts = [];
  const sku = li.productVariant?.sku || li.product?.sku;
  if (sku) parts.push(`SKU ${sku}`);
  parts.push(li.product?.productType === 'REFURBISHED' ? 'Refurbished' : 'New');
  if (li.pricingTier === 'ACCESS') parts.push('ACCESS price');
  const size = li.product?.sizeAgeGroup;
  if (size) parts.push(size);
  const variantLabel = formatVariantCombination(li.productVariant?.combination);
  if (variantLabel) parts.push(variantLabel);
  return parts.join(' · ');
}

async function buildInvoiceAttachment(orderPublicId) {
  try {
    const { renderInvoicePdfBuffer } = await import('./pdf/order-documents.service.js');
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      include: {
        orderItems: { include: { product: true, productVariant: true } },
        user: true,
      },
    });
    if (!order) {
      console.warn('[payment] invoice PDF skipped — order not found', orderPublicId);
      return null;
    }
    const buffer = await renderInvoicePdfBuffer(order);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      console.warn('[payment] invoice PDF skipped — empty buffer', orderPublicId);
      return null;
    }
    const label = order.orderNumber || order.publicId;
    console.info('[payment] invoice PDF ready for email', label, `${buffer.length} bytes`);
    return {
      filename: `invoice-${label}.pdf`,
      content: buffer,
      contentType: 'application/pdf',
    };
  } catch (err) {
    console.error('[payment] invoice PDF for email failed', orderPublicId, err);
    return null;
  }
}

async function resolveOrderPaymentMethodLabel(order) {
  if (!order?.stripePaymentIntentId) return 'Card';
  try {
    const stripe = getStripe();
    if (!stripe) return 'Card';
    const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId, {
      expand: ['payment_method'],
    });
    const pm = pi.payment_method;
    if (pm && typeof pm === 'object' && pm.card) {
      const brand = pm.card.brand ? String(pm.card.brand).replace(/^\w/, (c) => c.toUpperCase()) : 'Card';
      return `${brand} ending ${pm.card.last4 || '····'}`;
    }
  } catch {
    /* best-effort */
  }
  return 'Card';
}

async function sendOrderConfirmationEmail(orderPublicId) {
  const orderDetail = await prisma.order.findUnique({
    where: { publicId: orderPublicId },
    include: {
      orderItems: {
        include: {
          product: { select: { name: true, sku: true, productType: true, sizeAgeGroup: true } },
          productVariant: true,
        },
      },
      user: { select: { email: true, firstName: true, lastName: true, isGuest: true } },
      membershipPayment: { select: { amount: true } },
    },
  });
  const recipientEmail = orderDetail?.contactEmail || orderDetail?.user?.email;
  if (!recipientEmail) return;

  const activeItems = (orderDetail.orderItems || []).filter((li) => !li.cancelledAt);
  const subtotal = activeItems.reduce((sum, li) => sum + Number(li.price) * li.quantity, 0);
  const orderRef = orderDetail.orderNumber || orderDetail.publicId;
  const trackingUrl = buildOrderTrackingUrl({ orderNumber: orderRef, email: recipientEmail });
  const returnUrl = buildGuestReturnUrl({ orderNumber: orderRef, email: recipientEmail });
  const dashboardUrl = orderDetail.user?.isGuest
    ? trackingUrl
    : `${config.frontend.customerUrl}/dashboard/orders/${orderDetail.publicId}`;

  const taxAmount = Number(orderDetail.taxAmount || 0);
  const storeCredit = Number(orderDetail.storeCreditApplied || 0);
  const accessFee = Number(orderDetail.membershipPayment?.amount || 0);
  const customerName =
    [orderDetail.user?.firstName, orderDetail.user?.lastName].filter(Boolean).join(' ').trim() || null;
  const billToSource = orderDetail.billingAddressJson || orderDetail.shippingAddressJson;
  const shipToSource = orderDetail.shippingAddressJson || orderDetail.billingAddressJson;
  const paymentMethod = await resolveOrderPaymentMethodLabel(orderDetail);
  const attachment = await buildInvoiceAttachment(orderPublicId);

  await emailService.sendTemplate({
    to: recipientEmail,
    template: 'order-confirmation',
    context: {
      name: customerName || 'there',
      orderId: orderRef,
      issueDate: formatOrderIssueDate(orderDetail.createdAt),
      paymentStatus: titleCaseStatus(orderDetail.paymentStatus) || 'Paid',
      orderStatus: titleCaseStatus(orderDetail.status),
      billToLines: formatEmailAddressLines(billToSource, {
        name: customerName,
        email: recipientEmail,
        phone: orderDetail.contactPhone,
      }),
      shipToLines: formatEmailAddressLines(shipToSource, { name: customerName }),
      lines: activeItems.map((li) => {
        const unit = Number(li.price);
        const qty = li.quantity;
        return {
          name: li.product?.name || 'Item',
          meta: orderLineEmailMeta(li),
          qty,
          unitPrice: formatMoneyUsd(unit),
          amount: formatMoneyUsd(unit * qty),
          total: formatMoneyUsd(unit * qty),
        };
      }),
      subtotal: formatMoneyUsd(subtotal),
      shipping: formatMoneyUsd(orderDetail.shippingCost || 0),
      tax: taxAmount > 0 ? formatMoneyUsd(taxAmount) : null,
      storeCredit: storeCredit > 0 ? `-${formatMoneyUsd(storeCredit)}` : null,
      accessMembership: accessFee > 0 ? formatMoneyUsd(accessFee) : null,
      total: formatMoneyUsd(orderDetail.totalAmount),
      paymentMethod,
      shippingMethod: orderDetail.selectedRateServiceLevel || orderDetail.shippingCarrier || null,
      shippingAddress: formatEmailAddress(orderDetail.shippingAddressJson),
      actionUrl: dashboardUrl,
      trackingUrl,
      returnUrl,
      includeReturnEnvelope: Boolean(orderDetail.includeReturnEnvelope),
      invoiceAttached: Boolean(attachment),
    },
    attachments: attachment ? [attachment] : undefined,
  });

  if (attachment) {
    console.info('[payment] order confirmation emailed with invoice PDF', orderRef, recipientEmail);
  } else {
    console.warn('[payment] order confirmation emailed without invoice PDF', orderRef, recipientEmail);
  }
}

async function resolvePaymentSucceededForIntent(checkoutIntentPublicId, opts = {}) {
  const explicitAmount = Number.isInteger(opts.amountReceivedCents) ? opts.amountReceivedCents : null;
  const intent = await prisma.checkoutIntent.findUnique({
    where: { publicId: checkoutIntentPublicId },
    select: { stripePaymentIntentId: true, totalAmount: true },
  });
  const expectedCents = intent ? usdToCents(intent.totalAmount) : null;
  if (!intent) {
    return { succeeded: false, amountReceivedCents: explicitAmount, expectedCents };
  }

  const stripe = getStripe();
  const piId = opts.paymentIntentId || intent.stripePaymentIntentId;
  const canRetrieve = Boolean(stripe && piId && !String(piId).startsWith('cs_'));
  if (!canRetrieve) {
    return {
      succeeded: explicitAmount != null,
      amountReceivedCents: explicitAmount,
      expectedCents,
    };
  }

  try {
    const pi = await stripe.paymentIntents.retrieve(piId);
    const received = Number(pi.amount_received ?? pi.amount);
    return {
      succeeded: pi.status === 'succeeded',
      amountReceivedCents: Number.isInteger(received) ? received : explicitAmount,
      expectedCents,
    };
  } catch {
    return {
      succeeded: explicitAmount != null,
      amountReceivedCents: explicitAmount,
      expectedCents,
    };
  }
}

async function rejectMismatchedPaidCheckout(checkoutIntentPublicId, payment, opts) {
  const message = `Stripe charged ${payment.amountReceivedCents ?? 'unknown'} cents but checkout total is ${payment.expectedCents ?? 'unknown'} cents`;
  console.error('[stripe webhook] paid amount does not match checkout total', checkoutIntentPublicId, message);
  await recordOpenPaymentReconciliation(prisma, {
    checkoutIntentPublicId,
    paymentIntentId: opts.paymentIntentId || null,
    amountCents: Number.isInteger(payment.amountReceivedCents) ? payment.amountReceivedCents : null,
    error: message,
  });
  const error = new Error(message);
  error.code = 'CHECKOUT_AMOUNT_MISMATCH';
  throw error;
}

async function loadPaidOrderFromConsumedIntent(checkoutIntentPublicId) {
  const intent = await prisma.checkoutIntent.findUnique({
    where: { publicId: checkoutIntentPublicId },
    select: { status: true, orderPublicId: true },
  });
  if (intent?.status !== 'CONSUMED' || !intent.orderPublicId) {
    return null;
  }
  return prisma.order.findUnique({
    where: { publicId: intent.orderPublicId },
    include: { orderItems: { include: { product: true } } },
  });
}

async function handleCheckoutIntentPaymentCompleted(checkoutIntentPublicId, opts = {}) {
  if (!checkoutIntentPublicId) {
    return { handled: true, error: 'missing checkoutIntentPublicId' };
  }

  const intentBefore = await prisma.checkoutIntent.findUnique({
    where: { publicId: checkoutIntentPublicId },
    select: { status: true, orderPublicId: true, totalAmount: true },
  });
  if (!intentBefore) {
    return { handled: true, flow: 'order', error: 'missing checkout intent' };
  }
  const alreadyConsumed = intentBefore.status === 'CONSUMED' && intentBefore.orderPublicId;
  const payment = await resolvePaymentSucceededForIntent(checkoutIntentPublicId, opts);
  const paymentSucceeded = payment.succeeded;

  if (paymentSucceeded && !alreadyConsumed && !checkoutAmountMatches(payment.amountReceivedCents, payment.expectedCents)) {
    await rejectMismatchedPaidCheckout(checkoutIntentPublicId, payment, opts);
  }

  let paidOrder = null;
  try {
    paidOrder = await checkoutIntentService.createPaidOrderFromCheckoutIntent(checkoutIntentPublicId, {
      paymentSucceeded,
    });
  } catch (err) {
    paidOrder = await loadPaidOrderFromConsumedIntent(checkoutIntentPublicId);
    if (!paidOrder) {
      console.error('[stripe webhook] create order from checkout intent failed', checkoutIntentPublicId, err);
      if (!paymentSucceeded) {
        await checkoutIntentService.releaseIntentResources(checkoutIntentPublicId).catch((releaseErr) => {
          console.error('[stripe webhook] release checkout intent failed', checkoutIntentPublicId, releaseErr);
        });
        await prisma.checkoutIntent.updateMany({
          where: { publicId: checkoutIntentPublicId, status: 'PENDING' },
          data: { status: 'FAILED' },
        });
        return { handled: true, flow: 'order', error: String(err?.message || err) };
      }
      await recordOpenPaymentReconciliation(prisma, {
        checkoutIntentPublicId,
        paymentIntentId: opts.paymentIntentId || null,
        amountCents: Number.isInteger(payment.amountReceivedCents) ? payment.amountReceivedCents : usdToCents(intentBefore.totalAmount),
        error: String(err?.message || err),
      });
      throw err;
    }
  }

  if (paidOrder) {
    await resolveOpenPaymentReconciliations(prisma, checkoutIntentPublicId);
  }

  if (!alreadyConsumed && paidOrder?.publicId) {
    try {
      await sendOrderConfirmationEmail(paidOrder.publicId);
    } catch (emailErr) {
      console.error('[stripe webhook] order confirmation email failed', paidOrder.publicId, emailErr);
    }
    notifyNewPaidOrder(paidOrder);
  }

  return {
    handled: true,
    flow: 'order',
    alreadyPaid: Boolean(alreadyConsumed),
    orderPublicId: paidOrder?.publicId || intentBefore.orderPublicId || null,
  };
}

async function handleOrderPaymentCompleted(orderPublicId) {
  if (!orderPublicId) {
    return { handled: true, error: 'missing orderPublicId' };
  }
  const existingOrder = await prisma.order.findUnique({
    where: { publicId: orderPublicId },
    select: { paymentStatus: true },
  });
  if (!existingOrder) {
    return { handled: true, flow: 'order', error: 'missing order' };
  }
  const alreadyPaid = existingOrder.paymentStatus === 'PAID';

  let paidOrder = null;
  try {
    paidOrder = alreadyPaid
      ? await prisma.order.findUnique({
          where: { publicId: orderPublicId },
          select: { userId: true, publicId: true, orderNumber: true, totalAmount: true },
        })
      : await orderService.fulfillUnpaidOrderAfterPayment(orderPublicId);
  } catch (err) {
    console.error('[stripe webhook] fulfill order failed', orderPublicId, err);
    await orderService.releasePendingOrderResources(orderPublicId).catch((releaseErr) => {
      console.error('[stripe webhook] release pending resources failed', orderPublicId, releaseErr);
    });
    await prisma.order.updateMany({
      where: { publicId: orderPublicId, paymentStatus: 'UNPAID' },
      data: { paymentStatus: 'FAILED' },
    });
    return { handled: true, flow: 'order', error: String(err?.message || err) };
  }

  if (!alreadyPaid && paidOrder?.publicId) {
    try {
      await sendOrderConfirmationEmail(orderPublicId);
    } catch (emailErr) {
      console.error('[stripe webhook] order confirmation email failed', orderPublicId, emailErr);
    }
    notifyNewPaidOrder(paidOrder);
  }

  return { handled: true, flow: 'order', alreadyPaid };
}

export async function createOrderPaymentIntent(userPublicId, items, opts = {}) {
  refreshPrismaClientIfNeeded();
  const stripe = assertConnectAccountsForOrder();

  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: { email: true },
  });
  if (!user) {
    throw new AppError(401, 'Unauthorized');
  }

  const checkoutIntent = await checkoutIntentService.resolveCheckoutIntent(userPublicId, items, {
    shippingAddress: opts.shippingAddress,
    billingAddress: opts.billingAddress,
    parcels: opts.parcels,
    selectedRateId: opts.selectedRateId,
    selectedRate: opts.selectedRate,
    storeCreditToApply: opts.storeCreditToApply,
    checkoutIntentPublicId: opts.orderId,
    includeAccessMembership: opts.includeAccessMembership,
    membershipBabyName: opts.babyName,
    babyName: opts.babyName,
    contactEmail: opts.contactEmail,
    contactPhone: opts.contactPhone,
    sharedMembershipCode: opts.sharedMembershipCode,
  });

  return ensureCheckoutPaymentIntent(stripe, checkoutIntent, user, opts);
}

export async function getCheckoutSessionSummary(userPublicId, sessionId) {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError(503, 'Payments are not configured (missing STRIPE_SECRET_KEY)');
  }
  if (!sessionId || !String(sessionId).trim()) {
    throw new AppError(400, 'sessionId is required');
  }

  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: { id: true, publicId: true, email: true, firstName: true, lastName: true },
  });
  if (!user) {
    throw new AppError(401, 'Unauthorized');
  }

  const ref = String(sessionId).trim();
  const orderInclude = {
    orderItems: {
      include: {
        product: {
          select: {
            publicId: true,
            name: true,
            slug: true,
            imageUrl: true,
            price: true,
            compareAtPrice: true,
            memberPrice: true,
          },
        },
        productVariant: {
          select: {
            publicId: true,
            sku: true,
            imageUrl: true,
            combination: true,
          },
        },
      },
    },
    user: {
      select: {
        publicId: true,
        email: true,
        firstName: true,
        lastName: true,
        isGuest: true,
      },
    },
  };

  let order = await prisma.order.findFirst({
    where: {
      userId: user.id,
      OR: [{ stripeCheckoutSessionId: ref }, { stripePaymentIntentId: ref }],
    },
    include: orderInclude,
  });

  // PAY-06: this endpoint is read-only. Fulfilment stays on the Stripe webhook /
  // reconciliation path so the success page cannot race order creation.
  let session = null;
  if (!order) {
    try {
      session = await stripe.checkout.sessions.retrieve(ref, { expand: ['payment_intent'] });
    } catch {
      session = null;
    }

    const sessionIntentId = getCheckoutIntentPublicId(session?.metadata);
    if (sessionIntentId) {
      const intent = await prisma.checkoutIntent.findFirst({
        where: { publicId: sessionIntentId, userId: user.id },
        select: { orderPublicId: true },
      });
      if (intent?.orderPublicId) {
        order = await prisma.order.findUnique({
          where: { publicId: intent.orderPublicId, userId: user.id },
          include: orderInclude,
        });
      }
    }

    const orderPublicId = session?.metadata?.orderPublicId;
    if (!order && orderPublicId) {
      order = await prisma.order.findUnique({
        where: { publicId: orderPublicId, userId: user.id },
        include: orderInclude,
      });
    }
  }

  if (!order && ref.startsWith('pi_')) {
    const intentByPi = await prisma.checkoutIntent.findFirst({
      where: { stripePaymentIntentId: ref, userId: user.id },
      select: { orderPublicId: true },
    });
    if (intentByPi?.orderPublicId) {
      order = await prisma.order.findUnique({
        where: { publicId: intentByPi.orderPublicId, userId: user.id },
        include: orderInclude,
      });
    }
  }

  if (!order) {
    return {
      sessionId: ref,
      status: 'pending',
      placedAsGuest: false,
      trackingUrl: null,
      order: null,
      message: 'Payment is confirmed or still processing. Your order will appear when fulfilment finishes.',
    };
  }

  if (order.userId !== user.id) {
    throw new AppError(403, 'Unauthorized to access this checkout session');
  }

  const subtotal = order.orderItems.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
  let sessionAmountTotal = session && typeof session.amount_total === 'number' ? session.amount_total / 100 : null;
  let paymentMethodLabel = null;
  if (!sessionAmountTotal && ref.startsWith('pi_')) {
    try {
      const pi = await stripe.paymentIntents.retrieve(ref, { expand: ['payment_method'] });
      if (typeof pi.amount === 'number') sessionAmountTotal = pi.amount / 100;
      const pm = pi.payment_method;
      if (pm && typeof pm === 'object' && pm.card) {
        const brand = pm.card.brand ? String(pm.card.brand).replace(/^\w/, (c) => c.toUpperCase()) : 'Card';
        paymentMethodLabel = `${brand} ending ${pm.card.last4 || '····'}`;
      }
    } catch {
      sessionAmountTotal = null;
    }
  }
  const total = sessionAmountTotal ?? Number(order.totalAmount);

  const savingsToday = order.orderItems.reduce((sum, item) => {
    const paid = Number(item.price);
    const retail = Number(item.product?.compareAtPrice || item.product?.price || paid);
    const member = Number(item.product?.memberPrice || paid);
    const baseline = Math.max(retail, member);
    if (baseline > paid) return sum + (baseline - paid) * item.quantity;
    return sum;
  }, 0);

  const recipientEmail =
    session?.customer_details?.email || order.contactEmail || order.user?.email || user.email;
  const orderRef = order.orderNumber || order.publicId;
  const placedAsGuest = Boolean(order.placedAsGuest || order.user?.isGuest);
  const trackingUrl =
    recipientEmail && orderRef
      ? buildOrderTrackingUrl({ orderNumber: orderRef, email: recipientEmail })
      : null;

  return {
    sessionId: ref,
    status: 'ready',
    placedAsGuest,
    trackingUrl,
    order: {
      id: order.publicId,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      createdAt: order.createdAt,
      products: order.orderItems.map((item) => ({
        id: item.id,
        quantity: item.quantity,
        unitPrice: Number(item.price),
        lineTotal: Number(item.price) * item.quantity,
        product: item.product,
        variant: item.productVariant
          ? {
              id: item.productVariant.publicId,
              sku: item.productVariant.sku,
              imageUrl: item.productVariant.imageUrl,
              combination: item.productVariant.combination,
            }
          : null,
      })),
    },
    pricing: {
      currency: (session?.currency || 'usd').toUpperCase(),
      subtotal,
      shipping: Number(order.shippingCost || 0),
      tax: Number(order.taxAmount || 0),
      total: Math.max(total, subtotal + Number(order.shippingCost || 0) + Number(order.taxAmount || 0)),
    },
    payment: {
      sessionStatus: session?.status || null,
      paymentStatus: session?.payment_status || order.paymentStatus,
      customerEmail: recipientEmail,
      customerName:
        session?.customer_details?.name ||
        [order.user?.firstName, order.user?.lastName].filter(Boolean).join(' ') ||
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        null,
      methodLabel: paymentMethodLabel,
    },
    savingsToday: Math.round(savingsToday * 100) / 100,
    customer: {
      id: user.publicId,
      email: order.user?.email || user.email,
      firstName: order.user?.firstName || user.firstName || null,
      lastName: order.user?.lastName || user.lastName || null,
    },
    shipping: {
      address: order.shippingAddressJson || null,
      carrier: order.shippingCarrier || null,
      trackingNumber: order.trackingNumber || null,
      labelUrl: order.shippingLabelUrl || null,
      selectedRate: {
        rateId: order.selectedRateId || null,
        provider: order.selectedRateProvider || null,
        serviceLevel: order.selectedRateServiceLevel || null,
        amount: order.selectedRateAmount ?? null,
        currency: order.selectedRateCurrency || null,
        estimatedDays: order.selectedRateEstimatedDays ?? null,
      },
      returnLabel: {
        labelUrl: order.returnLabelUrl || null,
        carrier: order.returnShippingCarrier || null,
        trackingNumber: order.returnTrackingNumber || null,
      },
      tracking: {
        status: order.trackingStatus || null,
        statusDetails: order.trackingStatusDetails || null,
        statusDate: order.trackingStatusDate || null,
        eta: order.trackingEta || null,
        history: order.trackingHistoryJson || [],
      },
    },
  };
}

/** Thank-you page: confirm Stripe session and return ACCESS membership details. */
export async function getMembershipCheckoutSummary(userPublicId, sessionId) {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError(503, 'Payments are not configured (missing STRIPE_SECRET_KEY)');
  }
  const ref = String(sessionId || '').trim();
  if (!ref) {
    throw new AppError(400, 'session_id is required');
  }

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(ref);
  } catch {
    throw new AppError(404, 'Checkout session not found');
  }

  if (getFlow(session.metadata) !== 'membership') {
    throw new AppError(400, 'Not a Farmhouse Friends checkout session');
  }
  if (session.metadata?.userPublicId !== userPublicId) {
    throw new AppError(403, 'Unauthorized to access this checkout session');
  }

  const paid =
    session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (!paid) {
    throw new AppError(402, 'Payment is not complete yet. Please wait a moment and refresh.');
  }

  const { completeMembershipPayment } = await import('./membership.service.js');
  await completeMembershipPayment(session);

  const user = await prisma.user.findUnique({
    where: { publicId: userPublicId },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      babyName: true,
      accessNumber: true,
      accessMemberUntil: true,
    },
  });
  if (!user) {
    throw new AppError(401, 'Unauthorized');
  }

  const payment = await prisma.membershipPayment.findFirst({
    where: { stripeSessionId: ref },
    orderBy: { paidAt: 'desc' },
    select: { type: true, amount: true, accessValidUntil: true, paidAt: true },
  });

  const amountUsd =
    payment?.amount ??
    (typeof session.amount_total === 'number' ? session.amount_total / 100 : null);

  return {
    sessionId: ref,
    paymentType: payment?.type || 'PURCHASE',
    amount: amountUsd,
    accessNumber: user.accessNumber,
    validUntil: payment?.accessValidUntil || user.accessMemberUntil,
    customer: {
      email: session.customer_details?.email || user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      babyName: user.babyName,
    },
  };
}

export async function processStripeWebhook(rawBody, signatureHeader) {
  const stripe = getStripe();
  if (!stripe || !config.stripe.webhookSecret) {
    throw new Error('Webhook not configured');
  }

  const event = stripe.webhooks.constructEvent(
    rawBody,
    signatureHeader,
    config.stripe.webhookSecret
  );

  const claim = await beginStripeWebhookEvent(prisma, {
    eventId: event.id,
    type: event.type,
  });
  if (claim.action === 'skip') {
    return {
      handled: true,
      duplicate: claim.reason === 'duplicate' || claim.reason === 'in_progress' || claim.reason === 'lost_claim',
      type: event.type,
      reason: claim.reason,
    };
  }

  return finishStripeWebhookEvent(prisma, event.id, () => dispatchStripeWebhookEvent(event, stripe));
}

/** @param {import('stripe').Stripe.Event} event */
async function dispatchStripeWebhookEvent(event, stripe) {
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    const flow = getFlow(session.metadata);
    if (flow === 'membership') {
      const { completeMembershipPayment } = await import('./membership.service.js');
      return completeMembershipPayment(session);
    }
    if (flow === 'order') {
      return handleOrderCheckoutCompleted(session);
    }
    return { handled: false, type: event.type, flow };
  }

  if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    const session = event.data.object;
    const flow = getFlow(session.metadata);
    if (flow !== 'order') {
      return { handled: true, flow: flow || null, type: event.type };
    }
    return markOrderFlowPaymentFailed(session.metadata, event.type);
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    return handleOrderPaymentIntentSucceeded(paymentIntent);
  }

  if (event.type === 'payment_intent.payment_failed') {
    const paymentIntent = event.data.object;
    const flow = getFlow(paymentIntent.metadata);
    if (flow === 'order') {
      return markOrderFlowPaymentFailed(paymentIntent.metadata, event.type);
    }
    const paymentIntentId = typeof paymentIntent.id === 'string' ? paymentIntent.id : null;
    const sessionId = await getCheckoutSessionIdFromPaymentIntent(stripe, paymentIntentId);
    if (!sessionId) {
      return { handled: true, type: event.type, error: 'checkout session not found' };
    }
    await prisma.order.updateMany({
      where: { stripeCheckoutSessionId: sessionId, paymentStatus: 'UNPAID' },
      data: { paymentStatus: 'FAILED' },
    });
    return { handled: true, flow: 'order', type: event.type, sessionId };
  }

  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    await reverseOrderTransfersForCharge(stripe, charge);
    const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
    const sessionId = await getCheckoutSessionIdFromPaymentIntent(stripe, paymentIntentId);
    return markOrderRefundedBySessionId(sessionId || paymentIntentId, event.type);
  }

  return { handled: false, type: event.type };
}


export const supportedStripeWebhookEvents = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.expired',
  'checkout.session.async_payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
];
