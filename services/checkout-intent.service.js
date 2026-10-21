import { refreshPrismaClientIfNeeded } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { config } from '../config/env.js';
import { assertStockAvailable } from './inventory.service.js';
import { isSellableAvailable } from '../lib/inventory-stock-rules.js';

function db() {
  return refreshPrismaClientIfNeeded();
}

// Tax is charged on the product cost only — shipping and the ACCESS membership
// fee are not taxable. Store credit reduces the taxable product base.
function computeCheckoutTaxAmount(subtotal, shippingCost, accessFee, storeCreditApplied) {
  const taxable = Math.max(0, Number(subtotal || 0) - Number(storeCreditApplied || 0));
  return Math.round(taxable * config.salesTaxRate * 100) / 100;
}

function computeCheckoutTotal(subtotal, shippingCost, accessFee, storeCreditApplied) {
  const tax = computeCheckoutTaxAmount(subtotal, shippingCost, accessFee, storeCreditApplied);
  const total = Math.max(
    0,
    Number(subtotal || 0) +
      Number(shippingCost || 0) +
      Number(accessFee || 0) -
      Number(storeCreditApplied || 0) +
      tax
  );
  return Math.round(total * 100) / 100;
}

import {
  commitOrderLineStock,
  releaseOrderLineStock,
  reserveOrderLineStock,
  variantAvailableStock,
} from './inventory-reservation.js';
import { walletService } from './wallet.service.js';
import { postPaymentFulfillmentFields } from '../lib/order-fulfillment-start.js';
import { shippingService } from './shipping.service.js';
import {
  buildOrderLinePricing,
  resolveSelectedRate,
  selectedRateUpdateData,
} from './order.service.js';
import { getBusinessSettings } from './admin.service.js';
import { assertShareCodeAvailableForPayment, resolveSharedMembership } from './membership-sharing.service.js';
import { assertMembershipCheckoutAllowed } from './membership-eligibility.service.js';
import { assignOrderNumber, placeholderOrderNumber } from '../utils/order-number.js';
import { completeMembershipFromBundledCheckout } from './membership.service.js';
import { applyFreeShippingWaiver } from '../lib/free-shipping.js';
import {
  buildCheckoutSignature,
  buildCheckoutSignatureFromOrder,
} from '../utils/checkout-signature.js';

const intentInclude = {
  lines: {
    include: {
      product: true,
      productVariant: true,
    },
  },
};

function checkoutSignature(items, opts = {}) {
  return buildCheckoutSignature({
    items,
    selectedRateId: opts.selectedRateId,
    storeCreditToApply: opts.storeCreditToApply,
    shippingAddress: opts.shippingAddress,
    includeAccessMembership: opts.includeAccessMembership,
    babyName: opts.membershipBabyName || opts.babyName,
    sharedMembershipCode: opts.sharedMembershipCode,
  });
}

function signatureFromIntent(intent) {
  return buildCheckoutSignatureFromOrder(intent, intent.lines);
}

export class CheckoutIntentService {
  async findReusableIntent(userId, signature) {
    const since = new Date(Date.now() - config.pendingOrderTtlMinutes * 60 * 1000);
    const candidates = await db().checkoutIntent.findMany({
      where: {
        userId,
        status: 'PENDING',
        createdAt: { gte: since },
      },
      include: intentInclude,
      orderBy: { createdAt: 'desc' },
      take: 15,
    });

    for (const intent of candidates) {
      if (signatureFromIntent(intent) === signature) {
        return intent;
      }
    }
    return null;
  }

  async supersedeOtherIntents(userId, keepPublicId) {
    const since = new Date(Date.now() - config.pendingOrderTtlMinutes * 60 * 1000);
    const stale = await db().checkoutIntent.findMany({
      where: {
        userId,
        status: 'PENDING',
        publicId: { not: keepPublicId },
        createdAt: { gte: since },
      },
      select: { publicId: true },
    });

    for (const row of stale) {
      await this.releaseIntentResources(row.publicId).catch((err) => {
        console.error('[checkout-intent] supersede release failed', row.publicId, err);
      });
      await db().checkoutIntent.updateMany({
        where: { publicId: row.publicId, status: 'PENDING' },
        data: { status: 'FAILED' },
      });
    }
  }

  async reReserveIntentLinesInTx(tx, intent) {
    for (const line of intent.lines) {
      const product = await tx.product.findUnique({
        where: { id: line.productId },
        include: { variants: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!product) {
        throw new AppError(404, 'Product not found');
      }
      if (product.isDraft || !product.isActiveListing) {
        throw new AppError(400, `Product "${product.name}" is not available`);
      }
      await reserveOrderLineStock(tx, product, line.productVariantId, line.quantity, {
        referenceType: 'checkout_intent',
        referenceId: intent.publicId,
        actorUserId: intent.userId,
      });
    }
  }

  async releaseIntentResources(intentPublicId) {
    await db().$transaction(async (tx) => {
      const intent = await tx.checkoutIntent.findUnique({
        where: { publicId: intentPublicId },
        include: { lines: true },
      });
      if (!intent || intent.status === 'CONSUMED') return;

      for (const line of intent.lines) {
        const product = await tx.product.findUnique({
          where: { id: line.productId },
          include: { variants: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!product) continue;
        await releaseOrderLineStock(tx, product, line.productVariantId, line.quantity, {
          referenceType: 'checkout_intent',
          referenceId: intentPublicId,
          actorUserId: intent.userId,
        });
      }

      if (intent.storeCreditApplied > 0) {
        await walletService.releaseHoldInTx(
          tx,
          intent.userId,
          intent.storeCreditApplied,
          intentPublicId
        );
      }
    });
  }

  async resolveCheckoutIntent(userPublicId, items, opts = {}) {
    const user = await db().user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true },
    });
    if (!user) {
      throw new AppError(401, 'Unauthorized');
    }

    const { validateCartLines, toCheckoutItems, assertNoMaterialCartChanges } = await import(
      './cart-validation.service.js'
    );
    const validation = await validateCartLines(items, { mode: 'sanitize' });
    if (!validation.ok || !validation.items.length) {
      throw new AppError(
        400,
        validation.summary || 'No items in your cart are available for checkout.',
        'CART_INVALID',
        { removed: validation.removed, adjusted: validation.adjusted }
      );
    }
    assertNoMaterialCartChanges(validation);
    items = toCheckoutItems(validation.items);

    const signature = checkoutSignature(items, opts);

    if (opts.checkoutIntentPublicId) {
      const byId = await db().checkoutIntent.findFirst({
        where: {
          publicId: opts.checkoutIntentPublicId,
          userId: user.id,
          status: 'PENDING',
        },
        include: intentInclude,
      });
      if (byId && signatureFromIntent(byId) === signature) {
        await this.supersedeOtherIntents(user.id, byId.publicId);
        return byId;
      }
    }

    const reusable = await this.findReusableIntent(user.id, signature);
    if (reusable) {
      await this.supersedeOtherIntents(user.id, reusable.publicId);
      return reusable;
    }

    const intent = await this.createCheckoutIntent(userPublicId, items, opts);
    await this.supersedeOtherIntents(user.id, intent.publicId);
    return intent;
  }

  async createCheckoutIntent(userPublicId, items, opts = {}) {
    const { validateCartLines, toCheckoutItems, assertNoMaterialCartChanges } = await import(
      './cart-validation.service.js'
    );
    const validation = await validateCartLines(items, { mode: 'sanitize' });
    if (!validation.ok || !validation.items.length) {
      throw new AppError(
        400,
        validation.summary || 'No items in your cart are available for checkout.',
        'CART_INVALID',
        { removed: validation.removed, adjusted: validation.adjusted }
      );
    }
    assertNoMaterialCartChanges(validation);
    items = toCheckoutItems(validation.items);

    const user = await db().user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true, accessMemberUntil: true, babyName: true, isGuest: true, email: true, phone: true },
    });
    if (!user) {
      throw new AppError(401, 'Unauthorized');
    }

    const now = new Date();
    const hasAccess = Boolean(user.accessMemberUntil && user.accessMemberUntil > now);
    let includeAccessMembership = Boolean(opts.includeAccessMembership);
    if (user.isGuest && includeAccessMembership) {
      throw new AppError(
        403,
        'Farmhouse Friends requires a full account. Please sign in or create an account.',
        'FULL_ACCOUNT_REQUIRED'
      );
    }
    if (user.isGuest && Number(opts.storeCreditToApply || 0) > 0) {
      throw new AppError(403, 'Store credit requires a full account.', 'FULL_ACCOUNT_REQUIRED');
    }
    if (includeAccessMembership && hasAccess) {
      includeAccessMembership = false;
    }
    if (includeAccessMembership) {
      await assertMembershipCheckoutAllowed(userPublicId, { intent: 'purchase' });
      const babyName = String(opts.membershipBabyName || opts.babyName || user.babyName || '').trim();
      if (!babyName) {
        throw new AppError(400, 'Baby name is required when adding ACCESS at checkout', 'MEMBERSHIP_BABY_NAME_REQUIRED');
      }
    }

    let sharedAccess = null;
    const sharedCode = String(opts.sharedMembershipCode || '').trim();
    if (sharedCode && !hasAccess && !includeAccessMembership) {
      sharedAccess = await resolveSharedMembership(sharedCode, user.id);
    }
    const effectiveHasAccess = hasAccess || includeAccessMembership || Boolean(sharedAccess);
    const settings = await getBusinessSettings();
    const accessMembershipAmount = includeAccessMembership
      ? Number(settings.accessMembershipPriceUsd || 50)
      : 0;
    const membershipBabyName = includeAccessMembership
      ? String(opts.membershipBabyName || opts.babyName || user.babyName || '').trim()
      : null;

    const signature = checkoutSignature(items, {
      ...opts,
      includeAccessMembership,
      membershipBabyName,
      sharedMembershipCode: sharedAccess?.accessNumber || '',
    });
    const expiresAt = new Date(Date.now() + config.pendingOrderTtlMinutes * 60 * 1000);

    let subtotal = 0;
    let sharedDiscount = 0;
    const lineCreates = [];

    const intent = await db().$transaction(async (tx) => {
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

        if ((product.variants ?? []).length > 0) {
          if (!item.variantId) {
            throw new AppError(
              400,
              `Select a variant for "${product.name}"`,
              'VARIANT_REQUIRED'
            );
          }
        }

        if (item.variantId) {
          const v = product.variants.find((x) => x.publicId === item.variantId);
          if (!v) {
            throw new AppError(404, `Variant not found for item ${index + 1}`);
          }
          if (!isSellableAvailable(variantAvailableStock(v), product.productType)) {
            throw new AppError(400, `"${product.name}" is out of stock`);
          }
          if (variantAvailableStock(v) < item.quantity) {
            throw new AppError(400, `Insufficient stock for "${product.name}"`);
          }
          variant = v;
          variantDbId = v.id;
        } else {
          assertStockAvailable(product, item.quantity);
        }

        const linePricing = buildOrderLinePricing(product, variant, effectiveHasAccess);
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
        if (sharedAccess && linePricing.retailUnitPrice != null) {
          sharedDiscount += Math.max(0, Number(linePricing.retailUnitPrice) - Number(linePricing.price)) * item.quantity;
        }

        await reserveOrderLineStock(tx, product, variantDbId, item.quantity, {
          referenceType: 'checkout_intent',
          referenceId: signature,
          actorUserId: user.id,
        });
      }

      const contactEmail = String(opts.contactEmail || user.email || '').trim().toLowerCase() || null;
      const contactPhone = String(opts.contactPhone || user.phone || '').trim() || null;

      return tx.checkoutIntent.create({
        data: {
          userId: user.id,
          checkoutSignature: signature,
          status: 'PENDING',
          subtotal,
          shippingCost: 0,
          taxAmount: 0,
          totalAmount: subtotal + accessMembershipAmount,
          storeCreditApplied: 0,
          includeAccessMembership,
          accessMembershipAmount,
          membershipBabyName,
          sharedAccessOwnerId: sharedAccess?.ownerId ?? null,
          sharedAccessCodeId: sharedAccess?.codeId ?? null,
          sharedAccessNumber: sharedAccess?.accessNumber ?? null,
          sharedAccessDiscount: sharedAccess ? sharedDiscount : 0,
          contactEmail,
          placedAsGuest: Boolean(user.isGuest),
          shippingAddressJson: opts.shippingAddress ?? null,
          billingAddressJson: opts.billingAddress ?? null,
          expiresAt,
          lines: { create: lineCreates },
        },
        include: intentInclude,
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
        hasAccess: effectiveHasAccess,
      });
      selectedRate = resolveSelectedRate(shippingRates.rates, opts.selectedRateId, opts.selectedRate);
      shippingCost = applyFreeShippingWaiver(subtotal, Number(selectedRate?.amount || 0));
      shipmentId = shippingRates.shipmentId || null;
    } catch (error) {
      console.error('[checkout-intent] shipping rates failed', intent.publicId, error?.message || error);
      await this.releaseIntentResources(intent.publicId).catch((releaseErr) => {
        console.error('[checkout-intent] release after shipping error failed', releaseErr);
      });
      await db().checkoutIntent.update({
        where: { id: intent.id },
        data: { status: 'FAILED' },
      });
      if (!(error instanceof AppError)) {
        throw new AppError(502, 'Unable to calculate shipping for checkout', 'SHIPPING_RATE_FAILED');
      }
      throw error;
    }

    let storeCreditApplied = 0;
    if (opts.storeCreditToApply && Number(opts.storeCreditToApply) > 0) {
      try {
        const held = await walletService.holdCredit(
          user.id,
          opts.storeCreditToApply,
          intent.publicId
        );
        if (held > 0) {
          storeCreditApplied = held;
          intent.storeCreditApplied = held;
        }
      } catch (error) {
        await this.releaseIntentResources(intent.publicId).catch((releaseErr) => {
          console.error('[checkout-intent] release after credit hold error', releaseErr);
        });
        await db().checkoutIntent.update({
          where: { id: intent.id },
          data: { status: 'FAILED' },
        });
        throw error;
      }
    }

    const taxAmount = computeCheckoutTaxAmount(
      subtotal,
      shippingCost,
      accessMembershipAmount,
      storeCreditApplied
    );
    const totalAmount = computeCheckoutTotal(
      subtotal,
      shippingCost,
      accessMembershipAmount,
      storeCreditApplied
    );
    await db().checkoutIntent.update({
      where: { id: intent.id },
      data: {
        shippingCost,
        taxAmount,
        totalAmount,
        storeCreditApplied,
        shippingCarrier: selectedRate?.provider || null,
        ...selectedRateUpdateData(selectedRate, shipmentId),
      },
    });
    intent.shippingCost = shippingCost;
    intent.taxAmount = taxAmount;
    intent.totalAmount = totalAmount;
    intent.accessMembershipAmount = accessMembershipAmount;

    return db().checkoutIntent.findUnique({
      where: { id: intent.id },
      include: intentInclude,
    });
  }

  /** Create a paid Order from a consumed checkout intent (idempotent). */
  async createPaidOrderFromCheckoutIntent(checkoutIntentPublicId, options = {}) {
    const { paymentSucceeded = false } = options;
    const existing = await db().checkoutIntent.findUnique({
      where: { publicId: checkoutIntentPublicId },
      include: intentInclude,
    });
    if (!existing) {
      throw new AppError(404, 'Checkout not found');
    }

    if (existing.status === 'CONSUMED' && existing.orderPublicId) {
      return db().order.findUnique({
        where: { publicId: existing.orderPublicId },
        include: { orderItems: { include: { product: true } } },
      });
    }

    const recoverableFailed =
      paymentSucceeded && (existing.status === 'FAILED' || existing.status === 'EXPIRED');
    const canFulfill = existing.status === 'PENDING' || recoverableFailed;

    if (!canFulfill) {
      throw new AppError(409, 'Checkout is no longer valid', 'CHECKOUT_INTENT_INVALID');
    }

    if (recoverableFailed) {
      if (Number(existing.storeCreditApplied || 0) > 0) {
        await walletService.holdCredit(
          existing.userId,
          existing.storeCreditApplied,
          existing.publicId
        );
      }
    }

    const order = await db().$transaction(async (tx) => {
      const intent = await tx.checkoutIntent.findUnique({
        where: { publicId: checkoutIntentPublicId },
        include: { lines: true },
      });
      if (!intent) {
        throw new AppError(404, 'Checkout not found');
      }

      if (intent.status === 'CONSUMED' && intent.orderPublicId) {
        return tx.order.findUnique({
          where: { publicId: intent.orderPublicId },
          include: { orderItems: { include: { product: true } } },
        });
      }

      const intentRecoverable =
        paymentSucceeded && (intent.status === 'FAILED' || intent.status === 'EXPIRED');
      if (intent.status !== 'PENDING' && !intentRecoverable) {
        throw new AppError(409, 'Checkout already processed', 'CHECKOUT_INTENT_INVALID');
      }

      if (intentRecoverable) {
        await this.reReserveIntentLinesInTx(tx, intent);
        await tx.checkoutIntent.update({
          where: { id: intent.id },
          data: { status: 'PENDING' },
        });
      }

      const contactEmail = intent.contactEmail || null;
      const contactPhone =
        intent.shippingAddressJson && typeof intent.shippingAddressJson === 'object'
          ? intent.shippingAddressJson.phoneNumber || intent.shippingAddressJson.phone || null
          : null;

      const buyer = await tx.user.findUnique({
        where: { id: intent.userId },
        select: { accessMemberUntil: true, isGuest: true },
      });
      const hasAccess =
        buyer?.accessMemberUntil != null && new Date(buyer.accessMemberUntil) > new Date();
      const includeReturnEnvelope = Boolean(hasAccess && !intent.placedAsGuest);
      await assertShareCodeAvailableForPayment(tx, intent.sharedAccessCodeId);

      const created = await tx.order.create({
        data: {
          userId: intent.userId,
          orderNumber: placeholderOrderNumber(),
          totalAmount: intent.totalAmount,
          shippingCost: intent.shippingCost,
          taxAmount: intent.taxAmount ?? 0,
          storeCreditApplied: intent.storeCreditApplied,
          paymentStatus: 'PAID',
          status: 'PROCESSING',
          ...postPaymentFulfillmentFields(),
          contactEmail,
          contactPhone,
          placedAsGuest: Boolean(intent.placedAsGuest),
          includeReturnEnvelope,
          shippingAddressJson: intent.shippingAddressJson,
          billingAddressJson: intent.billingAddressJson,
          shippingCarrier: intent.shippingCarrier,
          stripePaymentIntentId: intent.stripePaymentIntentId,
          stripeCheckoutSessionId: intent.stripePaymentIntentId,
          shippingShipmentId: intent.shippingShipmentId,
          selectedRateId: intent.selectedRateId,
          selectedRateProvider: intent.selectedRateProvider,
          selectedRateServiceLevel: intent.selectedRateServiceLevel,
          selectedRateServiceToken: intent.selectedRateServiceToken,
          selectedRateAmount: intent.selectedRateAmount,
          selectedRateCurrency: intent.selectedRateCurrency,
          selectedRateEstimatedDays: intent.selectedRateEstimatedDays,
          accessMembershipIncluded: Boolean(intent.includeAccessMembership),
          sharedAccessOwnerId: intent.sharedAccessOwnerId ?? null,
          sharedAccessCodeId: intent.sharedAccessCodeId ?? null,
          sharedAccessNumber: intent.sharedAccessNumber ?? null,
          sharedAccessDiscount: Number(intent.sharedAccessDiscount || 0),
          orderItems: {
            create: intent.lines.map((line) => ({
              productId: line.productId,
              productVariantId: line.productVariantId,
              quantity: line.quantity,
              price: line.price,
              retailUnitPrice: line.retailUnitPrice ?? line.price,
              memberPriceSnapshot: line.memberPriceSnapshot ?? null,
              pricingTier: line.pricingTier || 'STANDARD',
            })),
          },
        },
        include: { orderItems: { include: { product: true } } },
      });
      await assignOrderNumber(tx, created.id);

      for (const line of intent.lines) {
        const product = await tx.product.findUnique({
          where: { id: line.productId },
          include: { variants: { orderBy: { sortOrder: 'asc' } } },
        });
        await commitOrderLineStock(tx, product, line.productVariantId, line.quantity, {
          referenceType: 'order',
          referenceId: created.publicId,
          actorUserId: intent.userId,
        });
      }

      if (intent.storeCreditApplied > 0) {
        await walletService.captureHoldInTx(
          tx,
          intent.userId,
          intent.storeCreditApplied,
          created.publicId
        );
      }

      await tx.checkoutIntent.update({
        where: { id: intent.id },
        data: { status: 'CONSUMED', orderPublicId: created.publicId },
      });

      const fullOrder = await tx.order.findUnique({
        where: { id: created.id },
        include: { orderItems: true },
      });
      const { createUnitsForPaidOrder } = await import('./product-unit.service.js');
      await createUnitsForPaidOrder(tx, fullOrder, fullOrder.orderItems);

      return tx.order.findUnique({
        where: { id: created.id },
        include: { orderItems: { include: { product: true } }, user: { select: { publicId: true } } },
      });
    });

    if (existing.includeAccessMembership && order) {
      const membershipPayment = await completeMembershipFromBundledCheckout({
        userId: existing.userId,
        userPublicId: order.user?.publicId,
        amountUsd: Number(existing.accessMembershipAmount || 0),
        stripeReferenceId: existing.stripePaymentIntentId || checkoutIntentPublicId,
        babyName: existing.membershipBabyName,
        shippingAddress: existing.shippingAddressJson,
      });
      if (membershipPayment?.id) {
        order = await db().order.update({
          where: { publicId: order.publicId },
          data: { membershipPaymentId: membershipPayment.id },
          include: { orderItems: { include: { product: true } } },
        });
      }
    }

    return order;
  }

  async expireStaleCheckoutIntents() {
    const ttlMs = config.pendingOrderTtlMinutes * 60 * 1000;
    const cutoff = new Date(Date.now() - ttlMs);
    const stale = await db().checkoutIntent.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: cutoff },
      },
      select: { publicId: true },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });

    for (const row of stale) {
      await this.releaseIntentResources(row.publicId).catch((err) => {
        console.error('[checkout-intent] expire release failed', row.publicId, err);
      });
      await db().checkoutIntent.updateMany({
        where: { publicId: row.publicId, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
    }

    return stale.length;
  }
}

export const checkoutIntentService = new CheckoutIntentService();
