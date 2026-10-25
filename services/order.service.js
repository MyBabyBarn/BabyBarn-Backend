import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { usdToCents } from '../lib/order-refund-balance.js';
import { AGE_AXIS_NAME, isCanonicalAge } from '../lib/age-groups.js';
import {
  buildAdminStatusGroupWhere,
  buildCustomerActiveWhere,
  buildCustomerDeliveredWhere,
  buildCustomerHasAnyReturnWhere,
  buildCustomerInTransitWhere,
  buildLegacyAdminPendingCountWhere,
} from '../lib/order-query-filters.js';

/** Canonical Age from a variant's combination, or null when absent/invalid. */
function variantAgeGroup(variant) {
  const combo = variant?.combination;
  const age = combo && typeof combo === 'object' ? combo[AGE_AXIS_NAME] : null;
  return isCanonicalAge(age) ? String(age).trim() : null;
}
import {
  assertAndDecrementOrderStock,
  assertStockAvailable,
  syncParentStockFromVariants,
} from './inventory.service.js';
import {
  commitOrderLineStock,
  releaseOrderLineStock,
  reserveOrderLineStock,
  variantAvailableStock,
} from './inventory-reservation.js';
import { walletService } from './wallet.service.js';
import { shippingService } from './shipping.service.js';
import { writeAdminAudit } from './audit.service.js';
import { assertGuestTrackVisible } from './guest-order-link.service.js';
import { GUEST_TRACK_WINDOW_DAYS } from '../lib/guest-order-visibility.js';
import {
  canCustomerCancelOrder,
  customerCancelUnavailableReason,
} from '../lib/customer-order-cancellation.js';
import { postPaymentFulfillmentFields } from '../lib/order-fulfillment-start.js';
import {
  classifyManualOrderStatusRequest,
  rejectManualOrderStatusUpdate,
} from '../lib/order-status-manual-update.js';
import {
  manualShipFromTrackingFields,
  shouldManualShipFromTracking,
} from '../lib/order-manual-ship-transition.js';
import { buildOutboundLabelPersistData } from '../lib/order-outbound-label-persist.js';
import { formatOrderLedgerLabel, orderLedgerNote } from '../lib/inventory-ledger-notes.js';
import * as orderDocuments from './pdf/order-documents.service.js';
import { emailService } from './email.service.js';
import { config } from '../config/env.js';
import { applyFreeShippingWaiver } from '../lib/free-shipping.js';
import { verifyOrderTrackingToken } from '../lib/order-tracking-token.js';
import { assignOrderNumber, placeholderOrderNumber } from '../utils/order-number.js';
import {
  buildCheckoutSignature,
  buildCheckoutSignatureFromOrder,
} from '../utils/checkout-signature.js';
import { buildParcelsForOrder } from './shipping/order-parcels.js';
import { assertMembershipCheckoutAllowed } from './membership-eligibility.service.js';
import { resolveSharedMembership } from './membership-sharing.service.js';
import fs from 'fs';
import path from 'path';
import { SHIPPING_LABELS_DIR } from '../utils/product-upload.js';

const orderItemAdminInclude = {
  product: {
    select: {
      publicId: true,
      name: true,
      sku: true,
      productType: true,
      imageUrl: true,
      price: true,
    },
  },
  productVariant: {
    select: { publicId: true, sku: true, combination: true, priceOverride: true },
  },
  pickedBy: {
    select: {
      publicId: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  },
};

const orderItemCustomerInclude = {
  product: {
    select: {
      id: true,
      publicId: true,
      name: true,
      slug: true,
      sku: true,
      productType: true,
      sizeAgeGroup: true,
      imageUrl: true,
      price: true,
      memberPrice: true,
      compareAtPrice: true,
    },
  },
  productVariant: {
    select: {
      id: true,
      publicId: true,
      sku: true,
      combination: true,
      imageUrl: true,
    },
  },
};

async function resolveActorUserId(actor) {
  if (!actor?.id) return null;
  const user = await prisma.user.findUnique({
    where: { publicId: actor.id },
    select: { id: true },
  });
  return user?.id ?? null;
}

let ensureOrderCheckoutColumnsPromise = null;

function isSchemaBootstrapSkippableError(error) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const msg = String(error?.message || '');
  return (
    code === '42501' ||
    /must be owner of table|permission denied|insufficient privilege/i.test(msg)
  );
}

async function ensureOrderCheckoutColumns() {
  if (!ensureOrderCheckoutColumnsPromise) {
    ensureOrderCheckoutColumnsPromise = prisma
      .$executeRawUnsafe(`
      ALTER TABLE "Order"
        ADD COLUMN IF NOT EXISTS "shippingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "shippingAddressJson" JSONB,
        ADD COLUMN IF NOT EXISTS "billingAddressJson" JSONB,
        ADD COLUMN IF NOT EXISTS "shippingCarrier" TEXT,
        ADD COLUMN IF NOT EXISTS "selectedRateId" TEXT,
        ADD COLUMN IF NOT EXISTS "selectedRateProvider" TEXT,
        ADD COLUMN IF NOT EXISTS "selectedRateServiceLevel" TEXT,
        ADD COLUMN IF NOT EXISTS "selectedRateServiceToken" TEXT,
        ADD COLUMN IF NOT EXISTS "selectedRateAmount" DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS "selectedRateCurrency" TEXT,
        ADD COLUMN IF NOT EXISTS "selectedRateEstimatedDays" INTEGER,
        ADD COLUMN IF NOT EXISTS "shippingShipmentId" TEXT,
        ADD COLUMN IF NOT EXISTS "shippingTransactionId" TEXT,
        ADD COLUMN IF NOT EXISTS "returnShipmentId" TEXT,
        ADD COLUMN IF NOT EXISTS "returnLabelUrl" TEXT,
        ADD COLUMN IF NOT EXISTS "returnTrackingNumber" TEXT,
        ADD COLUMN IF NOT EXISTS "returnShippingCarrier" TEXT,
        ADD COLUMN IF NOT EXISTS "returnTransactionId" TEXT,
        ADD COLUMN IF NOT EXISTS "trackingStatus" TEXT,
        ADD COLUMN IF NOT EXISTS "trackingStatusDetails" TEXT,
        ADD COLUMN IF NOT EXISTS "trackingStatusDate" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "trackingEta" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "trackingHistoryJson" JSONB,
        ADD COLUMN IF NOT EXISTS "stripeCheckoutSessionId" TEXT;
    `)
      .catch((error) => {
        ensureOrderCheckoutColumnsPromise = null;
        if (isSchemaBootstrapSkippableError(error)) {
          console.warn(
            '[order] checkout column bootstrap skipped (run prisma migrate deploy as DB owner)'
          );
          return;
        }
        throw error;
      });
  }
  await ensureOrderCheckoutColumnsPromise;
}

/** Same rules as checkout quote: variant override, then ACCESS memberPrice cap when eligible. */
function computeAppliedUnitPrice(product, variant, hasAccess) {
  let unitRetail = Number(product.price);
  let unitApplied = unitRetail;
  if (variant) {
    const vPrice = variant.priceOverride != null ? Number(variant.priceOverride) : unitRetail;
    unitRetail = vPrice;
    unitApplied = vPrice;
  }
  const variantMember =
    variant?.memberPriceOverride != null ? Number(variant.memberPriceOverride) : null;
  const productMember = product.memberPrice != null ? Number(product.memberPrice) : null;
  const memberCap = variantMember != null && variantMember > 0 ? variantMember : productMember;
  if (hasAccess && memberCap != null && memberCap > 0) {
    unitApplied = Math.min(unitApplied, memberCap);
  }
  return { unitRetail, unitApplied };
}

/** Persisted line pricing snapshot for orders and checkout intents. */
function buildOrderLinePricing(product, variant, effectiveHasAccess) {
  const { unitRetail, unitApplied } = computeAppliedUnitPrice(product, variant, effectiveHasAccess);
  const pricingTier =
    effectiveHasAccess && unitApplied < unitRetail ? 'ACCESS' : 'STANDARD';
  // Variant-aware Members Price at purchase — captured regardless of buyer's access state.
  const memberPriceSnapshot = computeAppliedUnitPrice(product, variant, true).unitApplied;
  return {
    price: unitApplied,
    retailUnitPrice: unitRetail,
    pricingTier,
    memberPriceSnapshot,
  };
}

function isMissingWalletTableError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'P2021' || error.code === 'P2022')
  );
}

const userForOrderList = {
  select: {
    id: true,
    publicId: true,
    email: true,
    firstName: true,
    lastName: true,
    accessMemberUntil: true,
    isGuest: true,
    role: { select: { name: true } },
  },
};

function parseDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function selectedRateUpdateData(selectedRate, shipmentId = null) {
  return {
    shippingShipmentId: shipmentId || null,
    selectedRateId: selectedRate?.rateId || null,
    selectedRateProvider: selectedRate?.provider || null,
    selectedRateServiceLevel: selectedRate?.serviceLevel || null,
    selectedRateServiceToken: selectedRate?.serviceToken || null,
    selectedRateAmount: selectedRate ? Number(selectedRate.amount || 0) : null,
    selectedRateCurrency: selectedRate?.currency || null,
    selectedRateEstimatedDays:
      selectedRate?.estimatedDays == null ? null : Number(selectedRate.estimatedDays || 0),
  };
}

function resolveSelectedRate(rates, requestedRateId, requestedRate = null) {
  const list = Array.isArray(rates) ? rates : [];
  const requested = String(requestedRateId || '').trim();
  if (!requested) return list[0] || null;
  const exact = list.find((rate) => String(rate?.rateId || '') === requested) || null;
  if (exact) return exact;
  const snapshot = requestedRate && typeof requestedRate === 'object' ? requestedRate : null;
  if (snapshot) {
    const provider = String(snapshot.provider || '').trim().toLowerCase();
    const token = String(snapshot.serviceToken || '').trim().toLowerCase();
    const level = String(snapshot.serviceLevel || '').trim().toLowerCase();
    const amount = Number(snapshot.amount);
    const fuzzy = list.find((rate) => {
      const rp = String(rate?.provider || '').trim().toLowerCase();
      const rt = String(rate?.serviceToken || '').trim().toLowerCase();
      const rl = String(rate?.serviceLevel || '').trim().toLowerCase();
      const ra = Number(rate?.amount || 0);
      const providerOk = provider ? rp === provider : true;
      const serviceOk = token ? rt === token : level ? rl === level : true;
      const amountOk = Number.isFinite(amount) ? Math.abs(ra - amount) < 0.011 : true;
      return providerOk && serviceOk && amountOk;
    });
    if (fuzzy) return fuzzy;
  }
  throw new AppError(409, 'Selected shipping rate is stale. Please refresh rates and choose again.', 'SHIPPING_RATE_STALE', {
    selectedRateId: requested,
    availableRateIds: list.map((rate) => String(rate?.rateId || '')).filter(Boolean),
  });
}

/** Match equivalent service tier across rate lists (ACCESS vs standard amounts differ). */
function matchRateByServiceTier(rates, reference) {
  const list = Array.isArray(rates) ? rates : [];
  if (list.length === 0) return null;
  if (!reference || typeof reference !== 'object') return list[0] || null;
  const token = String(reference.serviceToken || '').trim().toLowerCase();
  const level = String(reference.serviceLevel || '').trim().toLowerCase();
  const provider = String(reference.provider || '').trim().toLowerCase();
  if (token) {
    const byToken = list.find((rate) => String(rate?.serviceToken || '').trim().toLowerCase() === token);
    if (byToken) return byToken;
  }
  if (level) {
    const byLevel = list.find((rate) => String(rate?.serviceLevel || '').trim().toLowerCase() === level);
    if (byLevel) return byLevel;
  }
  if (provider) {
    const byProvider = list.find((rate) => String(rate?.provider || '').trim().toLowerCase() === provider);
    if (byProvider) return byProvider;
  }
  return list[0] || null;
}

/**
 * Group return request rows by submission for order detail / activity links.
 * One submission → one Return ID (even if multiple lines); multiple submissions → multiple IDs.
 */
function summarizeOrderReturns(returnRequests = []) {
  const bySubmission = new Map();
  for (const rr of returnRequests) {
    const submissionId = rr.submissionPublicId || rr.publicId;
    if (!submissionId) continue;
    let entry = bySubmission.get(submissionId);
    if (!entry) {
      entry = {
        id: submissionId,
        returnNumber: rr.returnNumber || null,
        type: rr.type || 'STANDARD',
        status: rr.status || null,
        createdAt: rr.createdAt || null,
        lineIds: [],
        productNames: [],
      };
      bySubmission.set(submissionId, entry);
    }
    if (rr.returnNumber && !entry.returnNumber) {
      entry.returnNumber = rr.returnNumber;
    }
    // Prefer a non-terminal / more advanced status for display when lines diverge.
    if (rr.status) entry.status = rr.status;
    const lineId = rr.orderItem?.publicId || null;
    if (lineId && !entry.lineIds.includes(lineId)) {
      entry.lineIds.push(lineId);
    }
    const productName = rr.orderItem?.product?.name || null;
    if (productName && !entry.productNames.includes(productName)) {
      entry.productNames.push(productName);
    }
  }
  return [...bySubmission.values()];
}

export class OrderService {
  async calculateCheckoutQuote(userPublicId, payload) {
    const user = await prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true, accessMemberUntil: true, babyName: true, isGuest: true },
    });
    if (!user) throw new AppError(401, 'Unauthorized');
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    if (rawItems.length === 0) throw new AppError(400, 'No items for checkout quote');

    const { validateCartLines, toCheckoutItems } = await import('./cart-validation.service.js');
    const validation = await validateCartLines(rawItems, { mode: 'sanitize' });
    if (!validation.ok || !validation.items.length) {
      throw new AppError(
        400,
        validation.summary || 'No items in your cart are available for checkout.',
        'CART_INVALID',
        { removed: validation.removed, adjusted: validation.adjusted }
      );
    }
    const items = toCheckoutItems(validation.items);

    const now = new Date();
    const hasAccess = Boolean(user.accessMemberUntil && user.accessMemberUntil > now);
    let includeAccessMembership = Boolean(payload?.includeAccessMembership);
    if (user.isGuest && includeAccessMembership) {
      throw new AppError(
        403,
        'Farmhouse Friends requires a full account. Please sign in or create an account.',
        'FULL_ACCOUNT_REQUIRED'
      );
    }
    if (includeAccessMembership && hasAccess) {
      includeAccessMembership = false;
    }
    if (includeAccessMembership) {
      await assertMembershipCheckoutAllowed(userPublicId, { intent: 'purchase' });
    }
    let sharedAccess = null;
    const sharedCode = String(payload?.sharedMembershipCode || '').trim();
    if (sharedCode && !hasAccess && !includeAccessMembership) {
      sharedAccess = await resolveSharedMembership(sharedCode, user.id);
    }
    const effectiveHasAccess = hasAccess || includeAccessMembership || Boolean(sharedAccess);
    let subtotalRetail = 0;
    let subtotalApplied = 0;
    let memberSubtotalIfAccess = 0;
    let potentialAccessPricingLineCount = 0;
    const lines = [];

    for (const item of items) {
      const product = await prisma.product.findUnique({
        where: { publicId: item.productId },
        include: { variants: true },
      });
      if (!product) throw new AppError(404, 'Product not found');

      const quantity = Math.max(1, Number(item.quantity || 1));
      let variant = null;
      if (item.variantId) {
        variant = product.variants.find((v) => v.publicId === item.variantId) || null;
        if (!variant) throw new AppError(404, 'Variant not found');
      }

      const linePricing = buildOrderLinePricing(product, variant, effectiveHasAccess);
      if (!hasAccess) {
        const memberLinePricing = buildOrderLinePricing(product, variant, true);
        memberSubtotalIfAccess += memberLinePricing.price * quantity;
        if (memberLinePricing.pricingTier === 'ACCESS') {
          potentialAccessPricingLineCount += 1;
        }
      }

      subtotalRetail += linePricing.retailUnitPrice * quantity;
      subtotalApplied += linePricing.price * quantity;
      lines.push({
        productId: product.publicId,
        variantId: variant?.publicId || null,
        name: product.name,
        quantity,
        retailUnitPrice: linePricing.retailUnitPrice,
        appliedUnitPrice: linePricing.price,
        pricingTier: linePricing.pricingTier,
        lineTotal: linePricing.price * quantity,
        condition: product.productType,
        sizeAgeGroup: variantAgeGroup(variant) || product.sizeAgeGroup || null,
      });
    }

    const accessDiscount = Math.max(0, subtotalRetail - subtotalApplied);
    const { getBusinessSettings } = await import('./admin.service.js');
    const settings = await getBusinessSettings();
    const accessMembershipAnnualFee = Number(settings.accessMembershipPriceUsd || 50);
    const accessMembershipFee = includeAccessMembership ? accessMembershipAnnualFee : 0;
    const shippingRates = await shippingService.getRates({
      shippingAddress: payload?.shippingAddress,
      parcels: payload?.parcels,
      preferProviderOnly: false,
      surface: 'checkout',
      hasAccess: effectiveHasAccess,
    });
    const selectedRate = resolveSelectedRate(shippingRates.rates, payload?.selectedRateId, payload?.selectedRate);
    const quotedShipping = Number(selectedRate?.amount || 0);
    const shippingCost = applyFreeShippingWaiver(subtotalApplied, quotedShipping);

    let accessSavings = null;
    if (!hasAccess) {
      const itemSavings = includeAccessMembership
        ? accessDiscount
        : Math.max(0, subtotalApplied - memberSubtotalIfAccess);
      let shippingSavings = 0;
      const compareShippingRates = await shippingService.getRates({
        shippingAddress: payload?.shippingAddress,
        parcels: payload?.parcels,
        preferProviderOnly: false,
        surface: 'checkout',
        hasAccess: !includeAccessMembership,
      });
      const compareRate = matchRateByServiceTier(compareShippingRates.rates, selectedRate);
      const compareShippingCost = applyFreeShippingWaiver(
        subtotalApplied,
        Number(compareRate?.amount || 0)
      );
      shippingSavings = Math.max(
        0,
        includeAccessMembership ? compareShippingCost - shippingCost : shippingCost - compareShippingCost
      );
      const totalSavings = Math.round((itemSavings + shippingSavings) * 100) / 100;
      accessSavings = {
        itemSavings: Math.round(itemSavings * 100) / 100,
        shippingSavings: Math.round(shippingSavings * 100) / 100,
        totalSavings,
        eligibleLineCount: potentialAccessPricingLineCount,
        annualFee: accessMembershipAnnualFee,
        netAnnualCostAfterToday: Math.max(0, Math.round((accessMembershipAnnualFee - totalSavings) * 100) / 100),
      };
    }

    let availableStoreCredit = 0;
    try {
      const wallet = await prisma.storeCreditWallet.findUnique({
        where: { userId: user.id },
        select: { balance: true },
      });
      availableStoreCredit = wallet?.balance || 0;
    } catch (error) {
      if (!isMissingWalletTableError(error)) {
        throw error;
      }
      // Wallet tables may not be migrated yet in some environments.
      availableStoreCredit = 0;
    }
    const requestedStoreCredit = Number(payload?.storeCreditToApply || 0);
    const storeCreditApplied = Math.max(
      0,
      Math.min(requestedStoreCredit, availableStoreCredit, subtotalApplied + shippingCost + accessMembershipFee)
    );
    // Tax applies to the product cost only — shipping and the ACCESS membership
    // fee are excluded from the taxable base.
    const taxAmount =
      Math.round(
        Math.max(0, subtotalApplied - storeCreditApplied) * config.salesTaxRate * 100
      ) / 100;
    const totalPayable = Math.max(
      0,
      subtotalApplied + shippingCost + accessMembershipFee - storeCreditApplied + taxAmount
    );

    const accessPricingLineCount = lines.filter((l) => l.pricingTier === 'ACCESS').length;

    return {
      hasAccess: effectiveHasAccess,
      includeAccessMembership,
      sharedMembership: sharedAccess
        ? {
            ownerName: sharedAccess.ownerName,
            status: sharedAccess.status,
            expiresAt: sharedAccess.expiresAt,
            accessNumber: sharedAccess.accessNumber,
            discount: accessDiscount,
          }
        : null,
      accessMembershipFee,
      accessMembershipAnnualFee: hasAccess ? 0 : accessMembershipAnnualFee,
      accessPricingLineCount,
      accessSavings,
      lines,
      shippingEstimate: {
        cost: shippingCost,
        provider: shippingRates.provider,
        isDemoRates: String(shippingRates.provider || '').toLowerCase() === 'demo',
        shipmentId: shippingRates.shipmentId || null,
        selectedRate,
        rates: shippingRates.rates || [],
        zone: selectedRate ? 'dynamic' : 'unknown',
        description: selectedRate
          ? `${selectedRate.provider} ${selectedRate.serviceLevel || 'shipping'}`
          : 'Shipping estimate unavailable',
      },
      pricing: {
        subtotalRetail,
        subtotalApplied,
        accessDiscount,
        accessMembershipFee,
        shippingCost,
        storeCreditAvailable: availableStoreCredit,
        storeCreditApplied,
        taxAmount,
        totalPayable,
      },
      cartValidation: {
        summary: validation.summary,
        removed: validation.removed,
        adjusted: validation.adjusted,
        items: validation.items.map((v) => ({
          productId: v.productId,
          variantId: v.variantId,
          quantity: v.quantity,
          maxQuantity: v.maxQuantity,
        })),
      },
    };
  }

  buildUserOrderListWhere(userId, filters = {}) {
    const and = [{ userId }];
    const periodMonths = filters.periodMonths != null ? String(filters.periodMonths) : '';
    if (periodMonths && periodMonths !== 'all') {
      const months = Number(periodMonths);
      if (!Number.isNaN(months) && months > 0) {
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - months);
        and.push({ createdAt: { gte: cutoff } });
      }
    }

    const tab = filters.tab ? String(filters.tab) : 'all';

    if (tab === 'delivered') {
      and.push(buildCustomerDeliveredWhere());
    } else if (tab === 'active') {
      and.push(buildCustomerActiveWhere());
    } else if (tab === 'returns') {
      and.push(buildCustomerHasAnyReturnWhere());
    }

    const search = filters.search ? String(filters.search).trim() : '';
    if (search) {
      and.push({
        OR: [
          { publicId: { contains: search, mode: 'insensitive' } },
          { orderNumber: { contains: search, mode: 'insensitive' } },
          {
            orderItems: {
              some: { product: { name: { contains: search, mode: 'insensitive' } } },
            },
          },
        ],
      });
    }

    return { AND: and };
  }

  async getUserOrders(userPublicId, page = 1, limit = 10, filters = {}) {
    const user = await prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true },
    });
    if (!user) {
      throw new AppError(401, 'Unauthorized');
    }

    const skip = (page - 1) * limit;
    const where = this.buildUserOrderListWhere(user.id, filters);

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          orderItems: {
            include: {
              ...orderItemCustomerInclude,
              returnRequests: {
                select: {
                  id: true,
                  publicId: true,
                  submissionPublicId: true,
                  status: true,
                  type: true,
                  quantity: true,
                  createdAt: true,
                },
                orderBy: { createdAt: 'desc' },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders,
      pagination: {
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit) || 1),
      },
    };
  }

  async getUserOrderStats(userPublicId, { periodMonths = '12' } = {}) {
    const user = await prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true },
    });
    if (!user) throw new AppError(401, 'Unauthorized');

    // Same builders as list tabs — count ≡ list predicate (ORD-001-P6d).
    const allWhere = this.buildUserOrderListWhere(user.id, { periodMonths, tab: 'all' });
    const activeWhere = this.buildUserOrderListWhere(user.id, { periodMonths, tab: 'active' });
    const deliveredWhere = this.buildUserOrderListWhere(user.id, {
      periodMonths,
      tab: 'delivered',
    });
    const returnsWhere = this.buildUserOrderListWhere(user.id, { periodMonths, tab: 'returns' });
    const inTransitWhere = {
      AND: [allWhere, buildCustomerInTransitWhere()],
    };

    const year = new Date().getFullYear();
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

    const [all, active, delivered, returns, inTransit, deliveredThisYear] = await Promise.all([
      prisma.order.count({ where: allWhere }),
      prisma.order.count({ where: activeWhere }),
      prisma.order.count({ where: deliveredWhere }),
      prisma.order.count({ where: returnsWhere }),
      prisma.order.count({ where: inTransitWhere }),
      prisma.order.count({
        where: {
          AND: [
            deliveredWhere,
            {
              OR: [
                { deliveredAt: { gte: yearStart, lte: yearEnd } },
                {
                  AND: [
                    { deliveredAt: null },
                    { createdAt: { gte: yearStart, lte: yearEnd } },
                  ],
                },
              ],
            },
          ],
        },
      }),
    ]);

    return {
      counts: {
        all,
        active,
        delivered,
        returns,
      },
      inTransit,
      deliveredThisYear,
    };
  }

  async getOrderById(orderPublicId, userPublicId) {
    const [order, viewer] = await Promise.all([
      prisma.order.findUnique({
        where: { publicId: orderPublicId },
        include: {
          orderItems: {
            include: {
              ...orderItemCustomerInclude,
              returnRequests: {
                select: {
                  id: true,
                  publicId: true,
                  submissionPublicId: true,
                  status: true,
                  type: true,
                  quantity: true,
                  createdAt: true,
                },
                orderBy: { createdAt: 'desc' },
              },
            },
          },
        },
      }),
      prisma.user.findUnique({
        where: { publicId: userPublicId },
        select: { id: true },
      }),
    ]);

    if (!order) {
      throw new AppError(404, 'Order not found');
    }
    if (!viewer) {
      throw new AppError(401, 'Unauthorized');
    }
    if (order.userId !== viewer.id) {
      throw new AppError(403, 'Unauthorized to access this order');
    }

    return order;
  }

  async trackPublicOrder({ token, orderNumber, email }) {
    let resolvedOrderNumber = orderNumber ? String(orderNumber).trim() : '';
    let resolvedEmail = email ? String(email).trim().toLowerCase() : '';

    if (token) {
      const verified = verifyOrderTrackingToken(token);
      resolvedOrderNumber = verified.orderNumber;
      resolvedEmail = verified.email;
    }

    if (!resolvedOrderNumber || !resolvedEmail) {
      throw new AppError(400, 'Order number and email are required', 'TRACKING_LOOKUP_REQUIRED');
    }

    const include = {
      orderItems: {
        include: {
          product: {
            select: { publicId: true, name: true, slug: true, imageUrl: true, productType: true },
          },
        },
      },
    };

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ orderNumber: resolvedOrderNumber }, { publicId: resolvedOrderNumber }],
        contactEmail: { equals: resolvedEmail, mode: 'insensitive' },
      },
      include,
    });

    const found =
      order ||
      (await prisma.order.findFirst({
        where: {
          OR: [{ orderNumber: resolvedOrderNumber }, { publicId: resolvedOrderNumber }],
          user: { email: { equals: resolvedEmail, mode: 'insensitive' } },
        },
        include,
      }));

    if (!found) {
      throw new AppError(404, 'Order not found. Check your order number and email.', 'ORDER_NOT_FOUND');
    }

    // Public guest tracking: last 45 days, or longer while a return is still open.
    const visible = await assertGuestTrackVisible(found);
    if (!visible) {
      throw new AppError(
        404,
        `This order is no longer available for guest tracking (orders older than ${GUEST_TRACK_WINDOW_DAYS} days are hidden once any return is closed). Sign in if you have a Baby Barn account.`,
        'GUEST_TRACK_EXPIRED'
      );
    }

    return this.formatPublicTrackingOrder(found);
  }

  formatPublicTrackingOrder(order) {
    const shipping = order.shippingAddressJson && typeof order.shippingAddressJson === 'object'
      ? order.shippingAddressJson
      : null;
    const canCancel = canCustomerCancelOrder(order);
    return {
      id: order.publicId,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      createdAt: order.createdAt,
      totalAmount: Number(order.totalAmount),
      shippingCost: Number(order.shippingCost || 0),
      trackingNumber: order.trackingNumber,
      shippingCarrier: order.shippingCarrier,
      trackingCarrier: order.shippingCarrier,
      trackingEta: order.trackingEta || null,
      placedAsGuest: Boolean(order.placedAsGuest),
      /** Email used for guest track / register prefill (caller already proved ownership). */
      contactEmail: order.contactEmail || null,
      cancellationReviewStatus: order.cancellationReviewStatus || null,
      canCancel,
      cancelUnavailableReason: canCancel ? null : customerCancelUnavailableReason(order),
      items: order.orderItems.map((item) => ({
        // Expose the public cuid as `id` directly so clients don't depend on
        // toPublicJson remapping (and never send a null/undefined item id).
        id: item.publicId,
        quantity: item.quantity,
        unitPrice: Number(item.price),
        lineTotal: Number(item.price) * item.quantity,
        cancelledAt: item.cancelledAt || null,
        product: item.product
          ? {
              id: item.product.publicId,
              name: item.product.name,
              slug: item.product.slug,
              imageUrl: item.product.imageUrl,
              productType: item.product.productType || 'NEW',
            }
          : null,
      })),
      shipping: shipping
        ? {
            city: shipping.city,
            state: shipping.state,
            zipCode: shipping.zipCode || shipping.postalCode,
          }
        : null,
    };
  }

  async createOrder(userPublicId, items) {
    if (config.nodeEnv === 'production') {
      throw new AppError(
        410,
        'Direct order creation is disabled. Use checkout and payment.',
        'USE_CHECKOUT'
      );
    }
    const user = await prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true },
    });
    if (!user) {
      throw new AppError(401, 'Unauthorized');
    }

    let totalAmount = 0;

    return prisma.$transaction(async (tx) => {
      const products = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const product = await tx.product.findUnique({
          where: { publicId: item.productId },
          include: { variants: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!product) {
          throw new AppError(404, `Product not found for item ${index + 1}`);
        }
        totalAmount += product.price * item.quantity;
        products.push(product);
      }

      for (let index = 0; index < items.length; index += 1) {
        await assertAndDecrementOrderStock(tx, products[index], items[index].quantity);
      }

      const order = await tx.order.create({
        data: {
          userId: user.id,
          orderNumber: placeholderOrderNumber(),
          totalAmount,
          paymentStatus: 'PAID',
          orderItems: {
            create: items.map((item, index) => ({
              productId: products[index].id,
              quantity: item.quantity,
              price: products[index].price,
            })),
          },
        },
        include: { orderItems: { include: { product: true } } },
      });
      await assignOrderNumber(tx, order.id);

      return tx.order.findUnique({
        where: { id: order.id },
        include: { orderItems: { include: { product: true } } },
      });
    });
  }

  checkoutSignature(items, opts = {}) {
    return buildCheckoutSignature({
      items,
      selectedRateId: opts.selectedRateId,
      storeCreditToApply: opts.storeCreditToApply,
      shippingAddress: opts.shippingAddress,
    });
  }

  async findReusablePendingCheckoutOrder(userId, signature) {
    const since = new Date(Date.now() - config.pendingOrderTtlMinutes * 60 * 1000);
    const candidates = await prisma.order.findMany({
      where: {
        userId,
        paymentStatus: 'UNPAID',
        status: 'PENDING',
        createdAt: { gte: since },
        stripePaymentIntentId: { not: null },
      },
      include: {
        orderItems: {
          include: {
            product: { select: { publicId: true } },
            productVariant: { select: { publicId: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 15,
    });

    for (const order of candidates) {
      if (buildCheckoutSignatureFromOrder(order, order.orderItems) === signature) {
        return order;
      }
    }
    return null;
  }

  /** Mark other in-progress checkout orders failed and release their holds. */
  async supersedeOtherPendingCheckoutOrders(userId, keepOrderPublicId) {
    const since = new Date(Date.now() - config.pendingOrderTtlMinutes * 60 * 1000);
    const stale = await prisma.order.findMany({
      where: {
        userId,
        paymentStatus: 'UNPAID',
        status: 'PENDING',
        publicId: { not: keepOrderPublicId },
        createdAt: { gte: since },
        stripePaymentIntentId: { not: null },
      },
      select: { publicId: true },
    });

    for (const row of stale) {
      await this.releasePendingOrderResources(row.publicId).catch((err) => {
        console.error('[order] supersede release failed', row.publicId, err);
      });
      await prisma.order.updateMany({
        where: { publicId: row.publicId, paymentStatus: 'UNPAID' },
        data: { paymentStatus: 'FAILED', status: 'CANCELLED' },
      });
    }
  }

  /**
   * One pending order per checkout fingerprint — avoids duplicate UNPAID rows when the client
   * re-fetches payment intents (React strict mode, address edits, step navigation).
   */
  async resolvePendingOrderForCheckout(userPublicId, items, opts = {}) {
    const user = await prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true },
    });
    if (!user) {
      throw new AppError(401, 'Unauthorized');
    }

    const signature = this.checkoutSignature(items, opts);

    if (opts.orderPublicId) {
      const byId = await prisma.order.findFirst({
        where: {
          publicId: opts.orderPublicId,
          userId: user.id,
          paymentStatus: 'UNPAID',
          status: 'PENDING',
        },
        include: {
          orderItems: {
            include: {
              product: { select: { publicId: true } },
              productVariant: { select: { publicId: true } },
            },
          },
        },
      });
      if (byId && buildCheckoutSignatureFromOrder(byId, byId.orderItems) === signature) {
        await this.supersedeOtherPendingCheckoutOrders(user.id, byId.publicId);
        return byId;
      }
    }

    const reusable = await this.findReusablePendingCheckoutOrder(user.id, signature);
    if (reusable) {
      await this.supersedeOtherPendingCheckoutOrders(user.id, reusable.publicId);
      return reusable;
    }

    const order = await this.createPendingOrderForStripe(userPublicId, items, opts);
    await this.supersedeOtherPendingCheckoutOrders(user.id, order.publicId);
    return order;
  }

  /**
   * Unpaid order for Stripe Checkout — stock validated but not decremented until webhook payment success.
   */
  async createPendingOrderForStripe(userPublicId, items, opts = {}) {
    await ensureOrderCheckoutColumns();

    const user = await prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true, accessMemberUntil: true },
    });
    if (!user) {
      throw new AppError(401, 'Unauthorized');
    }

    const now = new Date();
    const hasAccess = Boolean(user.accessMemberUntil && user.accessMemberUntil > now);

    let subtotal = 0;
    const lineCreates = [];

    const order = await prisma.$transaction(async (tx) => {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const product = await tx.product.findUnique({
          where: { publicId: item.productId },
          include: { variants: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!product) {
          throw new AppError(404, `Product not found for item ${index + 1}`);
        }
        if (product.isDraft || !product.isActiveListing) {
          throw new AppError(400, `Product "${product.name}" is not available`);
        }

        let variantDbId = null;
        let variant = null;

        if (item.variantId) {
          const v = product.variants.find((x) => x.publicId === item.variantId);
          if (!v) {
            throw new AppError(404, `Variant not found for item ${index + 1}`);
          }
          if (variantAvailableStock(v) < item.quantity) {
            throw new AppError(400, `Insufficient stock for "${product.name}"`);
          }
          variant = v;
          variantDbId = v.id;
        } else {
          assertStockAvailable(product, item.quantity);
        }

        const linePricing = buildOrderLinePricing(product, variant, hasAccess);
        subtotal += linePricing.price * item.quantity;
        lineCreates.push({
          productId: product.id,
          productVariantId: variantDbId,
          quantity: item.quantity,
          price: linePricing.price,
          retailUnitPrice: linePricing.retailUnitPrice,
          memberPriceSnapshot: linePricing.memberPriceSnapshot,
          pricingTier: linePricing.pricingTier,
        });

        await reserveOrderLineStock(tx, product, variantDbId, item.quantity, {
          referenceType: 'order',
          referenceId: `pending:${user.id}`,
          actorUserId: user.id,
        });
      }

      const created = await tx.order.create({
        data: {
          userId: user.id,
          orderNumber: placeholderOrderNumber(),
          totalAmount: subtotal,
          paymentStatus: 'UNPAID',
          status: 'PENDING',
          shippingCost: 0,
          shippingAddressJson: opts.shippingAddress ?? null,
          billingAddressJson: opts.billingAddress ?? null,
          shippingCarrier: null,
          orderItems: {
            create: lineCreates,
          },
        },
        include: { orderItems: { include: { product: true } } },
      });
      await assignOrderNumber(tx, created.id);
      return tx.order.findUnique({
        where: { id: created.id },
        include: { orderItems: { include: { product: true } } },
      });
    });

    let shippingCost = 0;
    let selectedRate = null;
    let shipmentId = null;
    try {
      const shippingRates = await shippingService.getRates({
        shippingAddress: opts.shippingAddress,
        parcels: opts.parcels,
        preferProviderOnly: false,
        surface: 'checkout',
        hasAccess,
      });
      selectedRate = resolveSelectedRate(shippingRates.rates, opts.selectedRateId, opts.selectedRate);
      shippingCost = applyFreeShippingWaiver(subtotal, Number(selectedRate?.amount || 0));
      shipmentId = shippingRates.shipmentId || null;
    } catch (error) {
      console.error('[order] checkout shipping rates failed', order.publicId, error?.message || error);
      await this.releasePendingOrderResources(order.publicId).catch((releaseErr) => {
        console.error('[order] failed to release resources after shipping error', releaseErr);
      });
      if (!(error instanceof AppError)) {
        throw new AppError(502, 'Unable to calculate shipping for checkout', 'SHIPPING_RATE_FAILED');
      }
      throw error;
    }

    let totalAmount = subtotal + shippingCost;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        shippingCost,
        shippingCarrier: selectedRate?.provider || null,
        totalAmount,
        ...selectedRateUpdateData(selectedRate, shipmentId),
      },
    });
    order.shippingCost = shippingCost;
    order.totalAmount = totalAmount;

    if (opts.storeCreditToApply && Number(opts.storeCreditToApply) > 0) {
      try {
        const held = await walletService.holdCredit(user.id, opts.storeCreditToApply, order.publicId);
        if (held > 0) {
          totalAmount = Math.max(0, totalAmount - held);
          await prisma.order.update({
            where: { id: order.id },
            data: { totalAmount, storeCreditApplied: held },
          });
          order.totalAmount = totalAmount;
          order.storeCreditApplied = held;
        }
      } catch (error) {
        await this.releasePendingOrderResources(order.publicId).catch((releaseErr) => {
          console.error('[order] failed to release resources after credit hold error', releaseErr);
        });
        throw error;
      }
    }

    return order;
  }

  /**
   * Release reserved stock (and optionally store-credit hold) for unpaid orders.
   * @param {string} orderPublicId
   * @param {{ itemPublicIds?: string[] | null, releaseStoreCredit?: boolean }} [opts]
   */
  async releasePendingOrderResources(orderPublicId, opts = {}) {
    const filterIds = Array.isArray(opts.itemPublicIds)
      ? new Set(opts.itemPublicIds.map(String))
      : null;
    const releaseStoreCredit = opts.releaseStoreCredit !== false;

    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { publicId: orderPublicId },
        include: { orderItems: true },
      });
      if (!order || order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIALLY_REFUNDED') {
        return;
      }

      const orderLabel = formatOrderLedgerLabel(order.orderNumber, orderPublicId);
      const releaseNote = orderLedgerNote('RELEASE', orderLabel);

      for (const line of order.orderItems) {
        if (line.cancelledAt) continue;
        if (filterIds && !filterIds.has(String(line.publicId))) continue;
        const product = await tx.product.findUnique({
          where: { id: line.productId },
          include: { variants: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!product) continue;
        await releaseOrderLineStock(tx, product, line.productVariantId, line.quantity, {
          referenceType: 'order',
          referenceId: orderPublicId,
          actorUserId: opts.actorUserId ?? order.userId,
          note: releaseNote,
        });
      }

      if (releaseStoreCredit && order.storeCreditApplied > 0 && !filterIds) {
        await walletService.releaseHoldInTx(
          tx,
          order.userId,
          order.storeCreditApplied,
          orderPublicId
        );
        await tx.order.update({
          where: { id: order.id },
          data: { storeCreditApplied: 0 },
        });
      }
    });
  }

  async fulfillUnpaidOrderAfterPayment(orderPublicId) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { publicId: orderPublicId },
        include: { orderItems: true },
      });
      if (!order) {
        throw new AppError(404, 'Order not found');
      }
      if (order.paymentStatus === 'PAID') {
        return order;
      }

      const orderLabel = formatOrderLedgerLabel(order.orderNumber, orderPublicId);
      const commitNote = orderLedgerNote('COMMIT', orderLabel);

      for (const line of order.orderItems) {
        if (line.cancelledAt) continue;
        const product = await tx.product.findUnique({
          where: { id: line.productId },
          include: { variants: { orderBy: { sortOrder: 'asc' } } },
        });
        await commitOrderLineStock(tx, product, line.productVariantId, line.quantity, {
          referenceType: 'order',
          referenceId: orderPublicId,
          actorUserId: order.userId,
          note: commitNote,
        });
      }

      if (order.storeCreditApplied > 0) {
        await walletService.captureHoldInTx(
          tx,
          order.userId,
          order.storeCreditApplied,
          orderPublicId
        );
      }

      const paid = await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'PAID',
          status: 'PROCESSING',
          // Auto-accept on payment — no admin Accept step; customer cancel is time-windowed.
          ...postPaymentFulfillmentFields(),
        },
        include: { orderItems: true },
      });
      const { createUnitsForPaidOrder } = await import('./product-unit.service.js');
      await createUnitsForPaidOrder(tx, paid, paid.orderItems);
      return tx.order.findUnique({
        where: { id: order.id },
        include: { orderItems: { include: { product: true } } },
      });
    });
  }

  /**
   * Compatibility endpoint for admin cancel only (ORD-001 Phase 2).
   * Free-form Order.status mutation is rejected — use fulfillment / refund / returns actions.
   */
  async updateOrderStatus(orderPublicId, status, actor) {
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      include: { orderItems: { include: { product: true } } },
    });

    if (!order) {
      throw new AppError(404, 'Order not found');
    }

    const kind = classifyManualOrderStatusRequest(status);

    if (kind === 'cancel') {
      if (order.status === 'CANCELLED') {
        return prisma.order.findUnique({
          where: { id: order.id },
          include: { orderItems: { include: { product: true } }, user: userForOrderList },
        });
      }
      const actorUserId = await resolveActorUserId(actor);
      const { order: updated } = await this.finalizeOrderCancellation(order, {
        reason: 'Cancelled by admin',
        actorUserId,
        reviewStatus: 'NONE',
      });
      await writeAdminAudit({
        actorId: actor?.id,
        actorEmail: actor?.email,
        action: 'ORDER_STATUS',
        entityType: 'Order',
        entityId: orderPublicId,
        meta: { from: order.status, to: 'CANCELLED', via: 'admin_cancel' },
      });
      return prisma.order.findUnique({
        where: { id: updated.id },
        include: { orderItems: { include: { product: true } }, user: userForOrderList },
      });
    }

    rejectManualOrderStatusUpdate(status);
  }

  async getAdminOrderStats() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [monthTotal, pendingFulfillment, pendingCancellation] = await Promise.all([
      prisma.order.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.order.count({ where: buildLegacyAdminPendingCountWhere() }),
      prisma.order.count({ where: { cancellationReviewStatus: 'PENDING' } }),
    ]);
    return { monthTotal, pendingFulfillment, pendingCancellation };
  }

  async getAllOrders(page = 1, limit = 20, filters = {}) {
    const skip = (page - 1) * limit;
    const {
      search,
      status,
      statusGroup,
      dateFrom,
      dateTo,
      cancellationReviewStatus,
      membershipFilter,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      fulfillmentStatus,
    } = filters;

    const and = [];
    const sg = statusGroup && String(statusGroup).trim();
    const st = status && String(status).trim();
    const statusGroupWhere = buildAdminStatusGroupWhere(sg, st);
    if (statusGroupWhere) {
      and.push(statusGroupWhere);
    } else if (st) {
      and.push({ status: st });
    }
    if (cancellationReviewStatus && String(cancellationReviewStatus).trim()) {
      and.push({ cancellationReviewStatus: String(cancellationReviewStatus).trim() });
    }
    const mf = membershipFilter && String(membershipFilter).trim();
    if (mf === 'access') {
      and.push({
        OR: [
          { accessMembershipIncluded: true },
          { orderItems: { some: { pricingTier: 'ACCESS' } } },
          {
            user: {
              isGuest: false,
              accessMemberUntil: { gt: new Date() },
            },
          },
        ],
      });
    } else if (mf === 'guest') {
      and.push({ user: { isGuest: true } });
    } else if (mf === 'standard') {
      and.push({
        accessMembershipIncluded: false,
        NOT: { orderItems: { some: { pricingTier: 'ACCESS' } } },
        user: {
          isGuest: false,
          OR: [{ accessMemberUntil: null }, { accessMemberUntil: { lte: new Date() } }],
        },
      });
    }
    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) range.gte = new Date(dateFrom);
      if (dateTo) {
        const e = new Date(dateTo);
        e.setHours(23, 59, 59, 999);
        range.lte = e;
      }
      and.push({ createdAt: range });
    }
    if (search && String(search).trim()) {
      const q = String(search).trim();
      and.push({
        OR: [
          { publicId: { contains: q, mode: 'insensitive' } },
          { orderNumber: { contains: q, mode: 'insensitive' } },
          { user: { email: { contains: q, mode: 'insensitive' } } },
          { user: { firstName: { contains: q, mode: 'insensitive' } } },
          { user: { lastName: { contains: q, mode: 'insensitive' } } },
        ],
      });
    }
    const fs = fulfillmentStatus && String(fulfillmentStatus).trim();
    if (fs) {
      and.push({ fulfillmentStatus: fs });
    }
    const where = and.length ? { AND: and } : {};

    const so = sortOrder === 'asc' ? 'asc' : 'desc';
    let orderBy = { createdAt: so };
    if (sortBy === 'totalAmount') {
      orderBy = { totalAmount: so };
    } else if (sortBy === 'status') {
      orderBy = { status: so };
    } else if (sortBy === 'createdAt') {
      orderBy = { createdAt: so };
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        include: {
          orderItems: { include: { product: true } },
          user: userForOrderList,
        },
        orderBy,
      }),
      prisma.order.count({ where }),
    ]);

    return {
      orders,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1,
      },
    };
  }

  async getOrderForAdmin(orderPublicId) {
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      include: {
        user: {
          select: {
            publicId: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            accessMemberUntil: true,
            isGuest: true,
          },
        },
        orderItems: {
          include: orderItemAdminInclude,
        },
        trackingEvents: { orderBy: { createdAt: 'desc' }, take: 80 },
        returnRequests: {
          select: {
            publicId: true,
            submissionPublicId: true,
            returnNumber: true,
            type: true,
            status: true,
            createdAt: true,
            orderItemId: true,
            orderItem: {
              select: {
                publicId: true,
                product: { select: { name: true } },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!order) {
      throw new AppError(404, 'Order not found');
    }

    const returns = summarizeOrderReturns(order.returnRequests || []);
    const returnsByLineId = new Map();
    for (const ret of returns) {
      for (const lineId of ret.lineIds) {
        if (!returnsByLineId.has(lineId)) returnsByLineId.set(lineId, []);
        returnsByLineId.get(lineId).push(ret);
      }
    }

    const orderItems = (order.orderItems || []).map((item) => ({
      ...item,
      returns: returnsByLineId.get(item.publicId) || [],
    }));

    return {
      ...order,
      orderItems,
      returns,
    };
  }

  async refundOrder(orderPublicId, actor, opts = {}) {
    const {
      assertRefundWithinRemaining,
      classifyStripeRefundError,
      derivePaymentStatusFromRefundTotals,
      fetchStripeRefundBalance,
      isRefundablePaymentStatus,
      localRemainingRefundableUsd,
      moneyRound,
      resolveAdminOrderRefundRequest,
      resolveRemainingRefundableCents,
      usdToCents,
    } = await import('../lib/order-refund-balance.js');

    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      include: { orderItems: true, user: userForOrderList },
    });
    if (!order) throw new AppError(404, 'Order not found');

    if (order.paymentStatus === 'REFUNDED' || order.status === 'REFUNDED') {
      throw new AppError(400, 'Order already refunded', 'ORDER_ALREADY_REFUNDED');
    }
    if (!isRefundablePaymentStatus(order.paymentStatus)) {
      throw new AppError(400, 'Order is not in a refundable payment state', 'ORDER_NOT_REFUNDABLE');
    }

    const { stripe, paymentIntentId } = await this.resolveStripePaymentIntentId(order);
    if (!stripe) {
      throw new AppError(503, 'Stripe is not configured', 'STRIPE_NOT_CONFIGURED');
    }
    if (!paymentIntentId) {
      throw new AppError(400, 'No Stripe payment reference found for this order', 'NO_PAYMENT_REFERENCE');
    }

    let stripeBalance;
    try {
      stripeBalance = await fetchStripeRefundBalance(stripe, paymentIntentId);
    } catch (err) {
      console.error('[order-refund] failed to load Stripe balance', orderPublicId, err);
      throw new AppError(
        502,
        'Unable to verify remaining refundable balance with Stripe. Try again shortly.',
        'STRIPE_BALANCE_UNAVAILABLE'
      );
    }

    const remainingCents = resolveRemainingRefundableCents({
      stripeRemainingCents: stripeBalance?.remainingCents,
      localRemainingUsd: localRemainingRefundableUsd(order),
    });

    const request = resolveAdminOrderRefundRequest({
      remainingCents,
      requestedAmountUsd: opts.amount,
    });
    if (!request.ok) {
      throw new AppError(400, request.message, request.code);
    }

    const refundAmountUsd = request.refundAmountUsd;
    const amountCents = request.requestedCents;
    // PAY-12: each refund attempt needs a unique Stripe idempotency key so two
    // equal partial refunds on the same order do not silently no-op.
    const refundAttemptId = crypto.randomBytes(8).toString('hex');
    const idempotencyKey = `order-admin-refund-${orderPublicId}-${amountCents}-${refundAttemptId}`.slice(
      0,
      255
    );

    let refund;
    try {
      refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount: amountCents,
          metadata: {
            orderPublicId,
            actorEmail: actor?.email || '',
            refundType: 'admin_order',
            isFullRemaining: request.isFullRemaining ? '1' : '0',
          },
        },
        { idempotencyKey }
      );
    } catch (err) {
      const classified = classifyStripeRefundError(err);
      if (classified) {
        throw new AppError(400, classified.message, classified.code);
      }
      console.error('[order-refund] Stripe refund create failed', orderPublicId, err);
      throw new AppError(
        502,
        'Stripe refund failed. No local refund was recorded — safe to retry.',
        'STRIPE_REFUND_FAILED'
      );
    }

    let balanceAfter = stripeBalance
      ? {
          amountPaidCents: stripeBalance.amountPaidCents,
          amountRefundedCents: stripeBalance.amountRefundedCents + amountCents,
          remainingCents: Math.max(0, stripeBalance.remainingCents - amountCents),
        }
      : null;
    try {
      const fresh = await fetchStripeRefundBalance(stripe, paymentIntentId);
      if (fresh) balanceAfter = fresh;
    } catch {
      // Non-fatal — use optimistic totals.
    }
    if (!balanceAfter) {
      balanceAfter = {
        amountPaidCents: amountCents,
        amountRefundedCents: amountCents,
        remainingCents: 0,
      };
    }

    const paymentStatus = derivePaymentStatusFromRefundTotals(
      balanceAfter.amountPaidCents,
      balanceAfter.amountRefundedCents
    );
    const actorUserId = await resolveActorUserId(actor);

    let updated;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const lockedRows = await tx.$queryRaw`
          SELECT id, "totalAmount", "paymentStatus", status
          FROM "Order"
          WHERE id = ${order.id}
          FOR UPDATE
        `;
        const locked = lockedRows?.[0];
        if (!locked) throw new AppError(404, 'Order not found');

        if (locked.paymentStatus === 'REFUNDED' || locked.status === 'REFUNDED') {
          throw new AppError(400, 'Order already refunded', 'ORDER_ALREADY_REFUNDED');
        }
        if (!isRefundablePaymentStatus(locked.paymentStatus)) {
          throw new AppError(
            400,
            'Order is not in a refundable payment state',
            'ORDER_NOT_REFUNDABLE'
          );
        }

        const localRemainingCents = usdToCents(localRemainingRefundableUsd(locked));
        const withinLocal = assertRefundWithinRemaining(amountCents, localRemainingCents);
        if (!withinLocal.ok) {
          throw new AppError(400, withinLocal.message, withinLocal.code);
        }

        const withItems = await tx.order.findUnique({
          where: { id: order.id },
          include: { orderItems: true },
        });
        const {
          appendAppliedStripeRefundId,
          hasAppliedStripeRefundId,
        } = await import('../lib/order-refund-side-effects.js');

        if (hasAppliedStripeRefundId(withItems.appliedStripeRefundIds, refund.id)) {
          return withItems;
        }

        // WS-A3 interim policy: restock merchandise only on full remaining close-out.
        // Partial admin refunds are money-only — PRODUCT DECISION REQUIRED for line restock.
        if (request.isFullRemaining) {
          const { restockPaidOrderInTx } = await import('./inventory-restock.service.js');
          const orderLabel = formatOrderLedgerLabel(order.orderNumber, orderPublicId);
          await restockPaidOrderInTx(tx, withItems, {
            referenceType: 'order',
            referenceId: orderPublicId,
            eventType: 'REFUND_RESTORE',
            note: orderLedgerNote('REFUND_RESTORE', orderLabel),
            actorUserId,
          });
        }

        const nextTotal = moneyRound(Math.max(0, Number(locked.totalAmount) - refundAmountUsd));
        const nextStatus =
          paymentStatus === 'REFUNDED' || request.isFullRemaining ? 'REFUNDED' : locked.status;
        const nextApplied = appendAppliedStripeRefundId(withItems.appliedStripeRefundIds, refund.id);

        return tx.order.update({
          where: { id: order.id },
          data: {
            status: nextStatus,
            paymentStatus,
            totalAmount: nextTotal,
            appliedStripeRefundIds: nextApplied,
          },
          include: { orderItems: { include: { product: true } }, user: userForOrderList },
        });
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(
        '[order-refund] Stripe refund succeeded but local persist failed',
        orderPublicId,
        refund.id,
        err
      );
      throw new AppError(
        500,
        `Stripe refund ${refund.id} succeeded but local recording failed. Retry this refund to reconcile.`,
        'ORDER_REFUND_PERSIST_FAILED',
        { stripeRefundId: refund.id, refundAmountUsd }
      );
    }

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'ORDER_REFUND',
      entityType: 'Order',
      entityId: orderPublicId,
      meta: {
        totalAmountBefore: order.totalAmount,
        shippingCost: order.shippingCost,
        stripeRefundId: refund.id,
        refundAmountUsd,
        paymentStatus,
        totalAmountAfter: updated.totalAmount,
        amountPaidCents: balanceAfter.amountPaidCents,
        amountRefundedCentsAfter: balanceAfter.amountRefundedCents,
        isFullRemaining: request.isFullRemaining,
      },
    });

    try {
      const customer = updated.user;
      if (customer?.email) {
        await emailService.sendTemplate({
          to: customer.email,
          template: 'refund-confirmation',
          context: {
            name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
            orderId: order.orderNumber || orderPublicId,
            amount: `$${refundAmountUsd.toFixed(2)}`,
            actionUrl: `${config.frontend.customerUrl}/dashboard/orders/${orderPublicId}`,
          },
        });
      }
    } catch (emailErr) {
      console.error('[order] refund confirmation email failed', orderPublicId, emailErr);
    }

    return updated;
  }

  async updateAdminShipping(orderPublicId, payload, actor) {
    const order = await prisma.order.findUnique({ where: { publicId: orderPublicId } });
    if (!order) throw new AppError(404, 'Order not found');
    const data = {};
    if (payload.trackingNumber != null && String(payload.trackingNumber).trim()) {
      data.trackingNumber = String(payload.trackingNumber).trim();
    }
    if (payload.shippingCarrier != null && String(payload.shippingCarrier).trim()) {
      data.shippingCarrier = String(payload.shippingCarrier).trim();
    }
    if (payload.shippingLabelUrl !== undefined) {
      const raw = payload.shippingLabelUrl ? String(payload.shippingLabelUrl).trim() : null;
      if (!raw) {
        data.shippingLabelUrl = null;
      } else if (/^\/uploads\/shipping-labels\/[A-Za-z0-9._-]+$/i.test(raw)) {
        data.shippingLabelUrl = raw;
      } else {
        throw new AppError(400, 'Invalid shipping label URL');
      }
    }
    if (payload.manualShippingNotes !== undefined) {
      data.manualShippingNotes = payload.manualShippingNotes
        ? String(payload.manualShippingNotes).trim()
        : null;
    }
    const shouldShip = shouldManualShipFromTracking({
      status: order.status,
      trackingNumber: data.trackingNumber,
    });
    if (shouldShip) {
      Object.assign(data, manualShipFromTrackingFields());
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data,
      include: { orderItems: { include: { product: true } }, user: userForOrderList },
    });
    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'ORDER_SHIPPING_UPDATED',
      entityType: 'Order',
      entityId: orderPublicId,
      meta: {
        trackingNumber: updated.trackingNumber,
        shippingCarrier: updated.shippingCarrier,
        statusChanged: shouldShip,
      },
    });
    if (shouldShip) {
      await writeAdminAudit({
        actorId: actor?.id,
        actorEmail: actor?.email,
        action: 'FULFILLMENT_mark_shipped',
        entityType: 'Order',
        entityId: orderPublicId,
        meta: { from: order.fulfillmentStatus, to: 'SHIPPED', via: 'manual_shipping' },
      });
    }
    return updated;
  }

  async getAdminShippingOptions(orderPublicId, payload = {}) {
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      select: { id: true, shippingAddressJson: true },
    });
    if (!order) throw new AppError(404, 'Order not found');
    if (!order.shippingAddressJson) {
      throw new AppError(400, 'Order does not have a shipping address', 'SHIPPING_ADDRESS_MISSING');
    }
    const ratesData = await shippingService.getRates({
      shippingAddress: order.shippingAddressJson,
      parcels: payload.parcels,
      preferProviderOnly: true,
      surface: 'admin',
      providerSlug: payload.providerSlug,
    });
    const carrierFilter = String(payload.carrier || '').trim().toLowerCase();
    const rates = carrierFilter
      ? (ratesData.rates || []).filter((r) =>
          String(r.provider || '').toLowerCase().includes(carrierFilter)
        )
      : ratesData.rates || [];
    const carriers = [...new Set((ratesData.rates || []).map((r) => String(r.provider || '').trim()).filter(Boolean))];
    return {
      shipmentId: ratesData.shipmentId,
      carriers,
      rates,
      diagnostics: ratesData.diagnostics || null,
    };
  }

  async getAdminReturnShippingOptions(orderPublicId, payload = {}) {
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      select: { id: true, shippingAddressJson: true },
    });
    if (!order) throw new AppError(404, 'Order not found');
    if (!order.shippingAddressJson) {
      throw new AppError(400, 'Order does not have a shipping address', 'SHIPPING_ADDRESS_MISSING');
    }
    const ratesData = await shippingService.getRates({
      fromAddress: order.shippingAddressJson,
      toAddress: shippingService.getConfiguredOriginAddress(),
      parcels: payload.parcels,
      preferProviderOnly: true,
      surface: 'admin',
      providerSlug: payload.providerSlug,
    });
    const carrierFilter = String(payload.carrier || '').trim().toLowerCase();
    const rates = carrierFilter
      ? (ratesData.rates || []).filter((r) =>
          String(r.provider || '').toLowerCase().includes(carrierFilter)
        )
      : ratesData.rates || [];
    const carriers = [...new Set((ratesData.rates || []).map((r) => String(r.provider || '').trim()).filter(Boolean))];
    return {
      shipmentId: ratesData.shipmentId,
      carriers,
      rates,
      diagnostics: ratesData.diagnostics || null,
    };
  }

  async resolveRateIdForOrder(order, payload = {}) {
    if (payload.rateId) return String(payload.rateId).trim();
    if (order.selectedRateId) return String(order.selectedRateId).trim();

    const parcels = payload.parcels || (await buildParcelsForOrder(order));
    const options = await this.getAdminShippingOptions(order.publicId, { parcels });
    const rates = options.rates || [];
    if (!rates.length) {
      throw new AppError(422, 'No UPS rates available for this order. Check UPS account activation.', 'SHIPPING_NO_RATES');
    }
    const matchToken = order.selectedRateServiceToken
      ? rates.find((r) => r.serviceToken === order.selectedRateServiceToken)
      : null;
    const matchLevel = order.selectedRateServiceLevel
      ? rates.find((r) => String(r.serviceLevel || '').includes(order.selectedRateServiceLevel))
      : null;
    return (matchToken || matchLevel || rates[0]).rateId;
  }

  async sendOrderTrackingEmail(order, trackingNumber) {
    const user = order.user;
    if (!user?.email || !trackingNumber) return;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'there';
    const actionUrl = `${config.frontend.customerUrl}/dashboard/orders/${order.publicId}`;
    try {
      await emailService.sendTemplate({
        to: user.email,
        template: 'order-tracking',
        context: {
          name,
          orderId: order.orderNumber || order.publicId,
          trackingNumber,
          carrier: order.shippingCarrier || 'UPS',
          actionUrl,
        },
      });
    } catch (err) {
      console.error('[order] tracking email failed', user.email, err);
    }
  }

  /**
   * Persist outbound UPS label fields on an order (ORD-001-P4 shared path).
   * Does not send email or write ORDER_LABEL_PURCHASED — callers own those.
   */
  async persistOutboundShippingLabel(orderPublicId, label, opts = {}) {
    const order = await prisma.order.findUnique({ where: { publicId: orderPublicId } });
    if (!order) throw new AppError(404, 'Order not found');

    const { data } = buildOutboundLabelPersistData({
      order,
      label,
      packageDetailsJson: opts.packageDetailsJson,
      shipmentId: opts.shipmentId,
      selectedRateUpdate: opts.selectedRateUpdate,
      at: opts.at,
    });

    const updateArgs = {
      where: { id: order.id },
      data,
    };
    if (opts.include !== false) {
      updateArgs.include = { orderItems: { include: { product: true } }, user: userForOrderList };
    }
    return prisma.order.update(updateArgs);
  }

  async generateAdminShippingLabel(orderPublicId, payload, actor) {
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      include: {
        orderItems: { include: { product: true, productVariant: true } },
        user: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    if (!order) throw new AppError(404, 'Order not found');
    if (!order.shippingAddressJson) {
      throw new AppError(400, 'Order has no shipping address', 'SHIPPING_ADDRESS_MISSING');
    }

    const parcels = payload.parcels?.length ? payload.parcels : await buildParcelsForOrder(order);
    const rateId = await this.resolveRateIdForOrder(order, { ...payload, parcels });

    const labelPayload = {
      ...payload,
      rateId,
      shippingAddress: order.shippingAddressJson,
      fromAddress: shippingService.getConfiguredOriginAddress(),
      parcels,
    };
    const label = await shippingService.generateLabel(labelPayload);

    const packageDetailsJson = {
      parcels,
      ups: {
        trackingNumber: label.trackingNumber || null,
        transactionId: label.transactionId || null,
        shipmentId: payload?.shipmentId || order.shippingShipmentId || null,
        labelUrl: label.shippingLabelUrl || null,
        generatedAt: new Date().toISOString(),
        serviceCode: order.selectedRateServiceToken || null,
      },
    };

    const updated = await this.persistOutboundShippingLabel(orderPublicId, label, {
      packageDetailsJson,
      shipmentId: payload?.shipmentId || order.shippingShipmentId || null,
      selectedRateUpdate: payload?.selectedRate
        ? selectedRateUpdateData(payload.selectedRate, payload?.shipmentId || order.shippingShipmentId)
        : null,
    });

    if (label.trackingNumber) {
      await this.sendOrderTrackingEmail(updated, label.trackingNumber);
    }

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'ORDER_LABEL_PURCHASED',
      entityType: 'Order',
      entityId: orderPublicId,
      meta: {
        rateId,
        labelFileType: payload?.labelFileType || 'PDF_4x6',
        trackingNumber: label.trackingNumber || null,
      },
    });
    return { order: updated, label };
  }

  /** One-click UPS label: order address + estimated parcel + checkout rate (or best UPS rate). */
  async generateAdminUpsLabel(orderPublicId, actor) {
    return this.generateAdminShippingLabel(orderPublicId, {}, actor);
  }

  async bulkGenerateAdminUpsLabels(orderPublicIds, actor) {
    const results = [];
    for (const pid of orderPublicIds) {
      try {
        const { order, label } = await this.generateAdminUpsLabel(pid, actor);
        results.push({
          id: pid,
          ok: true,
          trackingNumber: label.trackingNumber || order.trackingNumber,
          shippingLabelUrl: label.shippingLabelUrl || order.shippingLabelUrl,
        });
      } catch (e) {
        results.push({ id: pid, ok: false, error: e.message || String(e) });
      }
    }
    return { results };
  }

  async streamLabelsZip(res, orderPublicIds) {
    const orders = await prisma.order.findMany({
      where: { publicId: { in: orderPublicIds }, shippingLabelUrl: { not: null } },
      select: { publicId: true, shippingLabelUrl: true },
    });
    if (!orders.length) {
      throw new AppError(404, 'No orders with labels found');
    }

    const archiver = (await import('archiver')).default;
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="shipping-labels-${Date.now()}.zip"`
    );
    archive.pipe(res);

    const labelsRoot = path.resolve(SHIPPING_LABELS_DIR);
    for (const o of orders) {
      const url = String(o.shippingLabelUrl || '');
      if (!/^\/uploads\/shipping-labels\/[A-Za-z0-9._-]+$/i.test(url)) continue;
      const rel = url.replace(/^\/uploads\/shipping-labels\//i, '');
      const abs = path.resolve(labelsRoot, rel);
      if (!abs.startsWith(labelsRoot + path.sep)) continue;
      if (fs.existsSync(abs)) {
        archive.file(abs, { name: `${o.publicId}-${path.basename(abs)}` });
      }
    }
    await archive.finalize();
  }

  async generateAdminReturnLabel(orderPublicId, payload, actor) {
    const order = await prisma.order.findUnique({ where: { publicId: orderPublicId } });
    if (!order) throw new AppError(404, 'Order not found');
    const labelPayload = {
      ...payload,
      fromAddress: order.shippingAddressJson || payload.fromAddress,
      toAddress: shippingService.getConfiguredOriginAddress(),
      parcels: payload.parcels,
    };
    const label = await shippingService.generateLabel(labelPayload);
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        ...(payload?.shipmentId ? { returnShipmentId: String(payload.shipmentId) } : {}),
        ...(label.shippingLabelUrl ? { returnLabelUrl: label.shippingLabelUrl } : {}),
        ...(label.trackingNumber ? { returnTrackingNumber: label.trackingNumber } : {}),
        ...(label.shippingCarrier ? { returnShippingCarrier: label.shippingCarrier } : {}),
        ...(label.transactionId ? { returnTransactionId: label.transactionId } : {}),
      },
      include: { orderItems: { include: { product: true } }, user: userForOrderList },
    });
    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'ORDER_RETURN_LABEL_PURCHASED',
      entityType: 'Order',
      entityId: orderPublicId,
      meta: {
        rateId: payload?.rateId,
        labelFileType: payload?.labelFileType || 'PDF_4x6',
        trackingNumber: label.trackingNumber || null,
      },
    });
    return { order: updated, label };
  }

  /**
   * Attach outbound tracking (legacy admin API).
   * ORD-001-P3: when this path performs a ship transition, fulfillmentStatus,
   * Order.status, and outboundShippedAt update atomically (same semantics as
   * updateAdminShipping). UPS label generation remains PICKUP_READY + tracking.
   */
  async addTracking(orderPublicId, tracking, actor) {
    const order = await prisma.order.findUnique({ where: { publicId: orderPublicId } });
    if (!order) throw new AppError(404, 'Order not found');

    const trackingNumber = String(tracking.trackingNumber || '').trim();
    if (!trackingNumber) {
      throw new AppError(400, 'Tracking number is required');
    }

    const shouldShip = shouldManualShipFromTracking({
      status: order.status,
      trackingNumber,
    });

    const data = {
      trackingNumber,
      shippingCarrier: tracking.shippingCarrier || order.shippingCarrier || null,
      trackingStatus: tracking.status || null,
      trackingStatusDetails: tracking.statusDetails || null,
      trackingStatusDate: parseDateOrNull(tracking.statusDate),
      trackingEta: parseDateOrNull(tracking.eta),
      trackingHistoryJson: Array.isArray(tracking.history) ? tracking.history : [],
      ...(tracking.shippingLabelUrl !== undefined
        ? { shippingLabelUrl: tracking.shippingLabelUrl || null }
        : {}),
      ...(shouldShip ? manualShipFromTrackingFields() : {}),
    };

    const updated = await prisma.order.update({
      where: { id: order.id },
      data,
    });
    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'ORDER_TRACKING_ADDED',
      entityType: 'Order',
      entityId: orderPublicId,
      meta: {
        trackingNumber: updated.trackingNumber,
        shippingCarrier: updated.shippingCarrier,
        statusChanged: shouldShip,
        fulfillmentSynced: shouldShip,
      },
    });
    return updated;
  }

  async resolveStripePaymentIntentId(order) {
    const { getStripe } = await import('./payment.service.js');
    const stripe = getStripe();
    if (!stripe) return { stripe: null, paymentIntentId: null };

    let paymentIntentId = order.stripePaymentIntentId;
    if (!paymentIntentId && order.stripeCheckoutSessionId) {
      const ref = order.stripeCheckoutSessionId;
      if (ref.startsWith('pi_')) {
        paymentIntentId = ref;
      } else if (ref.startsWith('cs_')) {
        const session = await stripe.checkout.sessions.retrieve(ref);
        paymentIntentId =
          typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      }
    }
    return { stripe, paymentIntentId };
  }

  /**
   * Preview how a full (or partial) cancellation will split money across Stripe / store credit.
   * Does not mutate the order.
   */
  async getCancellationPreview(orderPublicId, { itemPublicIds = null } = {}) {
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      include: {
        orderItems: { include: { product: { select: { name: true } } } },
      },
    });
    if (!order) throw new AppError(404, 'Order not found');

    const { computeOrderCancellationBreakdown, moneyRound } = await import(
      '../lib/order-cancellation-preview.js'
    );
    const breakdown = computeOrderCancellationBreakdown(order, { itemPublicIds });
    if (!breakdown.ok) {
      throw new AppError(400, breakdown.message, breakdown.code);
    }

    let stripeRemainingUsd = null;
    let stripeRefundClamped = breakdown.stripeRefundAmount;
    let stripeWarning = null;

    if (breakdown.isPaid && breakdown.stripeRefundAmount > 0) {
      try {
        const { stripe, paymentIntentId } = await this.resolveStripePaymentIntentId(order);
        if (stripe && paymentIntentId) {
          const {
            fetchStripeRefundBalance,
            localRemainingRefundableUsd,
            resolveRemainingRefundableCents,
            usdToCents,
          } = await import('../lib/order-refund-balance.js');
          const stripeBalance = await fetchStripeRefundBalance(stripe, paymentIntentId);
          const remainingCents = resolveRemainingRefundableCents({
            stripeRemainingCents: stripeBalance?.remainingCents,
            localRemainingUsd: localRemainingRefundableUsd(order),
          });
          stripeRemainingUsd = moneyRound(remainingCents / 100);
          const amountCents = Math.min(usdToCents(breakdown.stripeRefundAmount), remainingCents);
          stripeRefundClamped = moneyRound(amountCents / 100);
          if (stripeRefundClamped < breakdown.stripeRefundAmount) {
            stripeWarning =
              'Stripe remaining balance is lower than the calculated refund — amount will be capped.';
          }
        }
      } catch {
        stripeWarning =
          'Could not verify Stripe remaining balance; amounts below are calculated from the order.';
      }
    }

    return {
      ...breakdown,
      stripeRefundAmount: stripeRefundClamped,
      stripeRefundEstimated: breakdown.stripeRefundAmount,
      stripeRemainingUsd,
      stripeWarning,
      customerReceivesTotal: moneyRound(stripeRefundClamped + breakdown.storeCreditRestore),
      orderId: order.publicId,
      orderNumber: order.orderNumber,
    };
  }

  /**
   * Cancel an entire order or selected line items before warehouse processing.
   * @param {object} order
   * @param {{ reason?: string|null, actorUserId?: number|null, reviewStatus?: string, itemPublicIds?: string[]|null }} opts
   */
  async finalizeOrderCancellation(
    order,
    { reason = null, actorUserId = null, reviewStatus = 'NONE', itemPublicIds = null } = {}
  ) {
    const { computeOrderCancellationBreakdown } = await import('../lib/order-cancellation-preview.js');
    const breakdown = computeOrderCancellationBreakdown(order, { itemPublicIds });
    if (!breakdown.ok) {
      throw new AppError(400, breakdown.message, breakdown.code);
    }

    const orderPublicId = order.publicId;
    const reasonTrimmed = reason?.trim() || null;
    const {
      cancellingAll,
      isPaid,
      lines,
      productAmount: cancelMerchandise,
      storeCreditApplied: storeCreditOnOrder,
      storeCreditRestore: creditShare,
      taxAmount: taxOnOrder,
      taxRefund: taxShare,
    } = breakdown;

    const linesToCancel = (order.orderItems || []).filter((line) =>
      lines.some((l) => String(l.id) === String(line.publicId))
    );

    let stripeRefundId = null;
    let refundAmountUsd = breakdown.stripeRefundAmount;

    if (isPaid && refundAmountUsd > 0) {
      const { stripe, paymentIntentId } = await this.resolveStripePaymentIntentId(order);
      if (!stripe) {
        throw new AppError(503, 'Stripe is not configured', 'STRIPE_NOT_CONFIGURED');
      }
      if (!paymentIntentId) {
        throw new AppError(400, 'No Stripe payment reference found for this order', 'NO_PAYMENT_REFERENCE');
      }

      const {
        assertRefundWithinRemaining,
        classifyStripeRefundError,
        fetchStripeRefundBalance,
        localRemainingRefundableUsd,
        resolveRemainingRefundableCents,
        usdToCents,
      } = await import('../lib/order-refund-balance.js');

      let stripeBalance;
      try {
        stripeBalance = await fetchStripeRefundBalance(stripe, paymentIntentId);
      } catch (err) {
        console.error('[order-cancel] failed to load Stripe balance', orderPublicId, err);
        throw new AppError(
          502,
          'Unable to verify remaining refundable balance with Stripe. Try again shortly.',
          'STRIPE_BALANCE_UNAVAILABLE'
        );
      }

      const remainingCents = resolveRemainingRefundableCents({
        stripeRemainingCents: stripeBalance?.remainingCents,
        localRemainingUsd: localRemainingRefundableUsd(order),
      });
      let amountCents = usdToCents(refundAmountUsd);
      const within = assertRefundWithinRemaining(amountCents, remainingCents);
      if (!within.ok) {
        if (remainingCents <= 0) {
          throw new AppError(400, within.message, within.code);
        }
        amountCents = Math.min(amountCents, remainingCents);
        refundAmountUsd = Math.round(amountCents) / 100;
      } else {
        amountCents = Math.min(amountCents, remainingCents);
        refundAmountUsd = Math.round((amountCents / 100) * 100) / 100;
      }

      if (amountCents > 0) {
        const lineKey = linesToCancel
          .map((l) => l.publicId)
          .sort()
          .join(',');
        try {
          const refund = await stripe.refunds.create(
            {
              payment_intent: paymentIntentId,
              amount: amountCents,
              metadata: {
                orderPublicId,
                source: cancellingAll ? 'customer_cancel' : 'customer_cancel_partial',
                itemPublicIds: lineKey.slice(0, 450),
              },
            },
            {
              idempotencyKey: `cancel-${orderPublicId}-${cancellingAll ? 'full' : lineKey}-${amountCents}`.slice(
                0,
                255
              ),
            }
          );
          stripeRefundId = refund.id;
        } catch (err) {
          const classified = classifyStripeRefundError(err);
          if (classified) {
            throw new AppError(400, classified.message, classified.code);
          }
          console.error('[order-cancel] Stripe refund create failed', orderPublicId, err);
          throw new AppError(
            502,
            'Stripe refund failed. No local cancellation was recorded — safe to retry.',
            'STRIPE_REFUND_FAILED'
          );
        }
      }
    } else if (!isPaid) {
      await this.releasePendingOrderResources(orderPublicId, {
        itemPublicIds: cancellingAll ? null : linesToCancel.map((l) => l.publicId),
        releaseStoreCredit: false,
      });
    }

    const cancelIds = linesToCancel.map((l) => l.publicId);
    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      const withItems = await tx.order.findUnique({
        where: { id: order.id },
        include: { orderItems: true, user: userForOrderList },
      });
      if (!withItems) throw new AppError(404, 'Order not found');

      let nextAppliedRefundIds = withItems.appliedStripeRefundIds;

      if (isPaid) {
        const {
          appendAppliedStripeRefundId,
          cancelCreditRestoreSourceKey,
          hasAppliedStripeRefundId,
        } = await import('../lib/order-refund-side-effects.js');

        const alreadyApplied =
          stripeRefundId && hasAppliedStripeRefundId(withItems.appliedStripeRefundIds, stripeRefundId);

        if (!alreadyApplied) {
          const { restockPaidOrderInTx } = await import('./inventory-restock.service.js');
          const orderLabel = formatOrderLedgerLabel(withItems.orderNumber, orderPublicId);
          await restockPaidOrderInTx(tx, withItems, {
            referenceType: 'order',
            referenceId: orderPublicId,
            eventType: 'REFUND_RESTORE',
            note: orderLedgerNote('REFUND_RESTORE', orderLabel),
            actorUserId,
            itemPublicIds: cancelIds,
          });
          if (creditShare > 0) {
            await walletService.refundRedeemedCreditInTx(
              tx,
              withItems.userId,
              creditShare,
              orderPublicId,
              {
                sourceKey: cancelCreditRestoreSourceKey(
                  orderPublicId,
                  stripeRefundId || `lines:${[...cancelIds].sort().join(',')}`
                ),
              }
            );
          }
        }

        if (stripeRefundId && !alreadyApplied) {
          nextAppliedRefundIds = appendAppliedStripeRefundId(
            withItems.appliedStripeRefundIds,
            stripeRefundId
          );
        }
      } else if (creditShare > 0) {
        await walletService.releaseHoldInTx(tx, withItems.userId, creditShare, orderPublicId);
      }

      await tx.orderItem.updateMany({
        where: {
          orderId: order.id,
          publicId: { in: cancelIds },
          cancelledAt: null,
        },
        data: {
          cancelledAt: now,
          cancellationReason: reasonTrimmed,
        },
      });

      const remainingActive = await tx.orderItem.count({
        where: { orderId: order.id, cancelledAt: null },
      });

      const nextStoreCredit = Math.max(
        0,
        Math.round((storeCreditOnOrder - creditShare) * 100) / 100
      );
      const nextTax = Math.max(0, Math.round((taxOnOrder - taxShare) * 100) / 100);
      let nextTotal;
      if (!isPaid && cancellingAll) {
        nextTotal = 0;
      } else if (!isPaid) {
        nextTotal = Math.max(
          0,
          Math.round((Number(order.totalAmount) - cancelMerchandise - taxShare + creditShare) * 100) /
            100
        );
      } else {
        nextTotal = Number(order.totalAmount);
      }
      const refundedAmountCents = isPaid
        ? Math.max(0, Number(order.refundedAmountCents || 0)) + usdToCents(refundAmountUsd)
        : Number(order.refundedAmountCents || 0);

      return tx.order.update({
        where: { id: order.id },
        data: {
          status: remainingActive === 0 ? 'CANCELLED' : order.status,
          paymentStatus: isPaid
            ? remainingActive === 0
              ? 'REFUNDED'
              : 'PARTIALLY_REFUNDED'
            : order.paymentStatus,
          fulfillmentStatus: remainingActive === 0 ? null : order.fulfillmentStatus,
          storeCreditApplied: isPaid ? Number(order.storeCreditApplied || 0) : nextStoreCredit,
          taxAmount: isPaid ? Number(order.taxAmount || 0) : nextTax,
          totalAmount: nextTotal,
          refundedAmountCents,
          cancellationReviewStatus: reviewStatus,
          cancellationRequestedAt: now,
          cancellationRequestReason: reasonTrimmed,
          cancellationReviewNote: null,
          ...(nextAppliedRefundIds != null
            ? { appliedStripeRefundIds: nextAppliedRefundIds }
            : {}),
        },
        include: {
          orderItems: { include: orderItemCustomerInclude },
          user: userForOrderList,
        },
      });
    });

    try {
      const customer = updated.user;
      if (customer?.email && cancellingAll) {
        const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
        await emailService.sendTemplate({
          to: customer.email,
          template: 'order-cancelled',
          context: {
            name,
            orderId: order.orderNumber || orderPublicId,
            reason: isPaid
              ? 'A refund has been initiated and may take 5–10 business days to appear.'
              : null,
            actionUrl: `${config.frontend.customerUrl}/dashboard/orders/${orderPublicId}`,
          },
        });
      }
    } catch (emailErr) {
      console.error('[order] cancellation email failed', orderPublicId, emailErr);
    }

    return {
      order: updated,
      isPaid,
      refundAmountUsd,
      stripeRefundId,
      partial: !cancellingAll,
    };
  }

  async cancelOrderByUser(orderPublicId, userPublicId, opts = {}) {
    const reason = typeof opts === 'string' ? opts : opts?.reason;
    const itemIds = typeof opts === 'string' ? null : opts?.itemIds;

    const [order, user] = await Promise.all([
      prisma.order.findUnique({
        where: { publicId: orderPublicId },
        include: { orderItems: true, user: userForOrderList },
      }),
      prisma.user.findUnique({ where: { publicId: userPublicId }, select: { id: true } }),
    ]);
    if (!order) throw new AppError(404, 'Order not found');
    if (!user || order.userId !== user.id) throw new AppError(403, 'Unauthorized to cancel this order');
    if (order.status === 'CANCELLED') {
      return {
        order,
        isPaid: order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUNDED',
        refundAmountUsd: 0,
        stripeRefundId: null,
        partial: false,
      };
    }
    if (!canCustomerCancelOrder(order)) {
      throw new AppError(400, customerCancelUnavailableReason(order));
    }

    return this.finalizeOrderCancellation(order, {
      reason,
      actorUserId: user.id,
      reviewStatus: 'NONE',
      itemPublicIds: Array.isArray(itemIds) && itemIds.length > 0 ? itemIds : null,
    });
  }

  /**
   * Guest self-service cancel: verify tracking token or order number + email,
   * then apply the same pre-shipment cancel rules as authenticated customers.
   */
  async cancelOrderByGuest(payload) {
    // SEC-08: guest cancel requires the signed tracking token (not order number + email alone).
    if (!payload.token) {
      throw new AppError(
        400,
        'A tracking link token is required to cancel this order.',
        'TRACKING_TOKEN_REQUIRED'
      );
    }
    const verified = verifyOrderTrackingToken(payload.token);
    const orderNumber = verified.orderNumber;
    const email = verified.email;

    if (!orderNumber || !email) {
      throw new AppError(400, 'Order number and email are required');
    }

    let order = await prisma.order.findFirst({
      where: {
        OR: [{ orderNumber }, { publicId: orderNumber }],
        contactEmail: { equals: email, mode: 'insensitive' },
      },
      include: {
        orderItems: true,
        user: { select: { publicId: true, id: true } },
      },
    });
    if (!order) {
      order = await prisma.order.findFirst({
        where: {
          OR: [{ orderNumber }, { publicId: orderNumber }],
          user: { email: { equals: email, mode: 'insensitive' } },
        },
        include: {
          orderItems: true,
          user: { select: { publicId: true, id: true } },
        },
      });
    }
    if (!order?.user) {
      throw new AppError(404, 'Order not found for that email');
    }

    return this.cancelOrderByUser(order.publicId, order.user.publicId, {
      reason: payload.reason,
      itemIds: payload.itemIds,
    });
  }

  /** @deprecated Use cancelOrderByUser — kept as alias for route handler compatibility. */
  async requestCancellationByUser(orderPublicId, userPublicId, reason) {
    const result = await this.cancelOrderByUser(orderPublicId, userPublicId, { reason });
    return result.order;
  }

  async reviewCancellationOrder(orderPublicId, { decision, note }, actor) {
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      include: { orderItems: true, user: userForOrderList },
    });
    if (!order) throw new AppError(404, 'Order not found');
    if (order.cancellationReviewStatus !== 'PENDING') {
      throw new AppError(400, 'No pending cancellation request for this order');
    }
    if (decision === 'approve') {
      const { order: updated } = await this.finalizeOrderCancellation(order, {
        reason: order.cancellationRequestReason,
        actorUserId: actor?.id ?? null,
        reviewStatus: 'APPROVED',
      });
      await writeAdminAudit({
        actorId: actor?.id,
        actorEmail: actor?.email,
        action: 'CANCELLATION_APPROVED',
        entityType: 'Order',
        entityId: orderPublicId,
        meta: { note: note?.trim() || null },
      });
      if (note?.trim()) {
        return prisma.order.update({
          where: { id: order.id },
          data: { cancellationReviewNote: note.trim() },
          include: { orderItems: { include: { product: true } }, user: userForOrderList },
        });
      }
      return updated;
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        cancellationReviewStatus: 'REJECTED',
        cancellationReviewNote: note?.trim() || null,
        cancellationRequestedAt: null,
        cancellationRequestReason: null,
      },
      include: { orderItems: { include: { product: true } }, user: userForOrderList },
    });
    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'CANCELLATION_REJECTED',
      entityType: 'Order',
      entityId: orderPublicId,
      meta: { note: note?.trim() || null },
    });
    return updated;
  }

  async patchOrderFulfillment(orderPublicId, body, actor) {
    const order = await prisma.order.findUnique({ where: { publicId: orderPublicId } });
    if (!order) throw new AppError(404, 'Order not found');
    const action = String(body.action || '').trim();
    const data = {};
    if (action === 'accept') {
      throw new AppError(
        400,
        'Orders are accepted automatically on payment. Use Mark picked when ready to fulfill.'
      );
    } else if (action === 'pickup_ready') {
      if (order.paymentStatus !== 'PAID' && order.paymentStatus !== 'PARTIALLY_REFUNDED') {
        throw new AppError(400, 'Only paid orders can be marked picked');
      }
      if (['CANCELLED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'REFUNDED'].includes(order.status)) {
        throw new AppError(400, `Cannot mark picked — order is ${order.status}`);
      }
      if (order.cancellationReviewStatus === 'PENDING') {
        throw new AppError(400, 'Cannot mark picked while cancellation review is pending');
      }
      const fs = String(order.fulfillmentStatus || '');
      if (
        ['PICKUP_READY', 'LABEL_GENERATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(
          fs
        )
      ) {
        // Idempotent: already past pick — return current order without rewrite.
        return prisma.order.findUnique({
          where: { id: order.id },
          include: { orderItems: { include: { product: true } }, user: userForOrderList },
        });
      }
      data.fulfillmentStatus = 'PICKUP_READY';
      data.pickupReadyAt = new Date();
      if (!order.fulfillmentAcceptedAt) {
        data.fulfillmentAcceptedAt = new Date();
      }
    } else if (action === 'mark_shipped') {
      const hasTracking = Boolean(String(order.trackingNumber || '').trim());
      const hasLabel = Boolean(String(order.shippingLabelUrl || '').trim());
      const overrideReason = String(body?.shipOverrideReason || '').trim();
      if (!hasTracking && !hasLabel && overrideReason.length < 3) {
        throw new AppError(
          400,
          'Add a tracking number or shipping label before marking shipped, or provide an override reason (min 3 characters).',
          'SHIP_TRACKING_REQUIRED'
        );
      }
      data.fulfillmentStatus = 'SHIPPED';
      data.outboundShippedAt = new Date();
      if (['PENDING', 'PROCESSING', 'CONFIRMED'].includes(order.status)) data.status = 'SHIPPED';
    } else if (action === 'mark_delivered') {
      data.fulfillmentStatus = 'DELIVERED';
      data.deliveredAt = new Date();
      data.status = 'DELIVERED';
    } else if (action === 'reject_unpaid') {
      if (order.paymentStatus !== 'UNPAID') {
        throw new AppError(400, 'Only unpaid orders can be rejected from this action');
      }
      await this.releasePendingOrderResources(order.publicId, { actorUserId: await resolveActorUserId(actor) });
      data.status = 'CANCELLED';
      data.fulfillmentStatus = null;
    } else {
      throw new AppError(400, 'Invalid fulfillment action', 'FULFILLMENT_ACTION_INVALID');
    }
    const updated = await prisma.order.update({
      where: { id: order.id },
      data,
      include: { orderItems: { include: { product: true } }, user: userForOrderList },
    });
    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: `FULFILLMENT_${action}`,
      entityType: 'Order',
      entityId: orderPublicId,
      meta: {
        from: order.fulfillmentStatus,
        to: updated.fulfillmentStatus,
        ...(action === 'mark_shipped' && String(body?.shipOverrideReason || '').trim()
          ? { shipOverrideReason: String(body.shipOverrideReason).trim() }
          : {}),
      },
    });
    return updated;
  }

  async pickOrderItem(orderPublicId, itemPublicId, body, actor) {
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      include: { orderItems: true },
    });
    if (!order) throw new AppError(404, 'Order not found');
    const line = order.orderItems.find((li) => li.publicId === itemPublicId);
    if (!line) throw new AppError(404, 'Order item not found');

    const pickedQuantity = Math.max(0, Math.min(Number(body.pickedQuantity ?? 0), line.quantity));
    const now = pickedQuantity > 0 ? new Date() : null;
    const pickerUserId = pickedQuantity > 0 ? await resolveActorUserId(actor) : null;

    await prisma.orderItem.update({
      where: { id: line.id },
      data: {
        pickedQuantity,
        pickedAt: pickedQuantity >= line.quantity ? now : pickedQuantity > 0 ? now : null,
        pickedByUserId: pickerUserId,
      },
    });

    let refreshed = await prisma.order.findUnique({
      where: { id: order.id },
      include: {
        orderItems: { include: orderItemAdminInclude },
        user: userForOrderList,
      },
    });

    const allPicked = refreshed.orderItems.every((li) => li.pickedQuantity >= li.quantity);
    if (
      allPicked &&
      refreshed.fulfillmentStatus === 'ACCEPTED' &&
      refreshed.paymentStatus === 'PAID'
    ) {
      const prevFulfillment = refreshed.fulfillmentStatus;
      refreshed = await prisma.order.update({
        where: { id: order.id },
        data: { fulfillmentStatus: 'PICKUP_READY', pickupReadyAt: new Date() },
        include: {
          orderItems: { include: orderItemAdminInclude },
          user: userForOrderList,
        },
      });
      await writeAdminAudit({
        actorId: actor?.id,
        actorEmail: actor?.email,
        action: 'FULFILLMENT_pickup_ready',
        entityType: 'Order',
        entityId: orderPublicId,
        meta: { from: prevFulfillment, to: 'PICKUP_READY', via: 'all_items_picked' },
      });
    }

    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'ORDER_ITEM_PICKED',
      entityType: 'OrderItem',
      entityId: itemPublicId,
      meta: { orderPublicId, pickedQuantity, quantity: line.quantity },
    });

    return refreshed;
  }

  async bulkPatchOrderFulfillment({ orderPublicIds, action }, actor) {
    const results = [];
    for (const pid of orderPublicIds) {
      try {
        const o = await this.patchOrderFulfillment(pid, { action }, actor);
        results.push({ id: pid, ok: true, order: o });
      } catch (e) {
        results.push({ id: pid, ok: false, error: e.message });
      }
    }
    return { results };
  }

  async createPickupList({ orderPublicIds, title }, actor) {
    const orders = await prisma.order.findMany({
      where: { publicId: { in: orderPublicIds } },
      include: {
        user: { select: { email: true, firstName: true, lastName: true, phone: true } },
        orderItems: {
          include: {
            product: true,
            productVariant: { select: { sku: true } },
          },
        },
      },
    });
    if (!orders.length) throw new AppError(400, 'No matching orders');

    const terminal = new Set(['CANCELLED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'REFUNDED']);
    const pastPick = new Set([
      'PICKUP_READY',
      'LABEL_GENERATED',
      'SHIPPED',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]);
    const eligible = [];
    const skipped = [];
    for (const o of orders) {
      if (terminal.has(o.status)) {
        skipped.push({ id: o.publicId, reason: `status ${o.status}` });
        continue;
      }
      if (o.cancellationReviewStatus === 'PENDING') {
        skipped.push({ id: o.publicId, reason: 'cancellation review pending' });
        continue;
      }
      if (o.paymentStatus !== 'PAID' && o.paymentStatus !== 'PARTIALLY_REFUNDED') {
        skipped.push({ id: o.publicId, reason: 'not paid' });
        continue;
      }
      if (pastPick.has(String(o.fulfillmentStatus || ''))) {
        skipped.push({ id: o.publicId, reason: 'already picked or further along' });
        continue;
      }
      eligible.push(o);
    }
    if (!eligible.length) {
      throw new AppError(
        400,
        'No eligible orders for a pick wave. Orders must be paid, not cancelled/shipped, and not already picked.'
      );
    }

    // Preserve caller order for eligible ids only.
    const byId = new Map(eligible.map((o) => [o.publicId, o]));
    const ordered = orderPublicIds.map((id) => byId.get(id)).filter(Boolean);

    const list = await prisma.pickupList.create({
      data: {
        title: title || `Pickup ${new Date().toISOString().slice(0, 10)}`,
        lines: {
          create: ordered.map((o, i) => ({ orderId: o.id, sortOrder: i })),
        },
      },
      include: { lines: { include: { order: true } } },
    });
    await writeAdminAudit({
      actorId: actor?.id,
      actorEmail: actor?.email,
      action: 'PICKUP_LIST_CREATED',
      entityType: 'PickupList',
      entityId: list.publicId,
      meta: { count: ordered.length, skipped },
    });
    return { ...list, skipped };
  }

  async getPickupListForPdf(publicId) {
    const list = await prisma.pickupList.findUnique({
      where: { publicId },
      include: {
        lines: {
          orderBy: { sortOrder: 'asc' },
          include: {
            order: {
              include: {
                user: { select: { email: true, firstName: true, lastName: true, phone: true } },
                orderItems: { include: { product: true, productVariant: true } },
              },
            },
          },
        },
      },
    });
    if (!list) throw new AppError(404, 'Pickup list not found');
    return {
      title: list.title,
      orders: list.lines.map((l) => l.order),
    };
  }

  async getOrderPdfBuffer(orderPublicId, kind) {
    const order = await prisma.order.findUnique({
      where: { publicId: orderPublicId },
      include: {
        orderItems: { include: { product: true, productVariant: { select: { sku: true } } } },
        user: true,
      },
    });
    if (!order) throw new AppError(404, 'Order not found');
    if (kind === 'invoice') return orderDocuments.renderInvoicePdfBuffer(order);
    if (kind === 'packing') return orderDocuments.renderPackingSlipPdfBuffer(order);
    if (kind === 'summary') return orderDocuments.renderShippingSummaryPdfBuffer(order);
    if (kind === 'pick-list') {
      return orderDocuments.renderPickupListPdfBuffer({
        title: `Pick list — ${order.orderNumber || order.publicId}`,
        orders: [order],
      });
    }
    throw new AppError(400, 'Unknown PDF kind', 'PDF_KIND_INVALID');
  }

  async syncUpsTrackingBatch() {
    const orders = await prisma.order.findMany({
      where: {
        trackingNumber: { not: null },
        status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED', 'REFUNDED'] },
      },
      take: 40,
    });
    let touched = 0;
    for (const order of orders) {
      try {
        const t = await shippingService.trackShipment(order.shippingCarrier || 'UPS', order.trackingNumber);
        const statusUp = String(t.status || '').toUpperCase();
        let fulfillment = order.fulfillmentStatus;
        if (statusUp.includes('DELIVERED')) fulfillment = 'DELIVERED';
        else if (statusUp.includes('OUT FOR')) fulfillment = 'OUT_FOR_DELIVERY';
        else if (
          statusUp.includes('TRANSIT') ||
          statusUp.includes('DEPART') ||
          statusUp.includes('ARRIVAL') ||
          statusUp.includes('SCAN')
        ) {
          fulfillment = 'IN_TRANSIT';
        }
        const statusChanged = String(t.status || '') !== String(order.trackingStatus || '');
        if (statusChanged) {
          await prisma.shipmentTrackingEvent.create({
            data: {
              orderId: order.id,
              source: 'ups',
              statusCode: String(t.status || '').slice(0, 120),
              description: t.statusDetails || null,
              raw: t.raw || t,
              eventAt: t.statusDate ? new Date(t.statusDate) : new Date(),
            },
          });
        }
        await prisma.order.update({
          where: { id: order.id },
          data: {
            trackingStatus: t.status || null,
            trackingStatusDetails: t.statusDetails || null,
            trackingStatusDate: t.statusDate ? new Date(t.statusDate) : new Date(),
            trackingEta: t.eta ? new Date(t.eta) : order.trackingEta,
            trackingHistoryJson: Array.isArray(t.history) ? t.history : [],
            ...(fulfillment ? { fulfillmentStatus: fulfillment } : {}),
            ...(fulfillment === 'DELIVERED' ? { status: 'DELIVERED', deliveredAt: new Date() } : {}),
          },
        });
        touched += 1;
      } catch {
        /* ignore */
      }
    }
    return { scanned: orders.length, touched };
  }

  /** Expire unpaid checkout orders and release reserved inventory / store credit holds. */
  async expireStalePendingOrders() {
    const ttlMs = config.pendingOrderTtlMinutes * 60 * 1000;
    const cutoff = new Date(Date.now() - ttlMs);
    const stale = await prisma.order.findMany({
      where: {
        paymentStatus: 'UNPAID',
        createdAt: { lt: cutoff },
      },
      select: { publicId: true },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });

    for (const row of stale) {
      await this.releasePendingOrderResources(row.publicId).catch((err) => {
        console.error('[order] expire cleanup release failed', row.publicId, err);
      });
      await prisma.order.updateMany({
        where: { publicId: row.publicId, paymentStatus: 'UNPAID' },
        data: { paymentStatus: 'FAILED' },
      });
    }

    return stale.length;
  }
}

export const orderService = new OrderService();

export { computeAppliedUnitPrice, buildOrderLinePricing, resolveSelectedRate, selectedRateUpdateData };
