import { prisma } from '../lib/prisma.js';
import { AppError } from '../utils/error-handler.js';
import { writeAdminAudit } from './audit.service.js';
import { PORTAL_SCOPE, findUserByEmailAndPortal } from '../lib/portal-scope.js';

function placeholderOrderNumber() {
  return `TMP-${Date.now().toString(36).toUpperCase()}`;
}

async function assignOrderNumber(tx, orderId) {
  const year = new Date().getFullYear();
  const seq = await tx.order.count({
    where: {
      id: { lte: orderId },
      createdAt: {
        gte: new Date(`${year}-01-01T00:00:00.000Z`),
        lt: new Date(`${year + 1}-01-01T00:00:00.000Z`),
      },
    },
  });
  const orderNumber = `BB-${year}-${String(seq).padStart(5, '0')}`;
  await tx.order.update({ where: { id: orderId }, data: { orderNumber } });
  return orderNumber;
}

/**
 * Admin-placed order (HTML Create order). Recorded as PAID (card-at-desk / offline).
 * Decrements variant or product stock. Customer must exist on the customer portal.
 */
export async function createAdminPlacedOrder(actorPublicId, payload) {
  const email = String(payload.customerEmail || '')
    .trim()
    .toLowerCase();
  if (!email) throw new AppError(400, 'Customer email is required');
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) throw new AppError(400, 'Add at least one line item');

  const customer = await findUserByEmailAndPortal(prisma, email, PORTAL_SCOPE.CUSTOMER);
  if (!customer) {
    throw new AppError(404, 'No customer account found for that email', 'CUSTOMER_NOT_FOUND');
  }

  const actor = await prisma.user.findUnique({
    where: { publicId: actorPublicId },
    select: { id: true, email: true },
  });
  if (!actor) throw new AppError(401, 'Unauthorized');

  const order = await prisma.$transaction(async (tx) => {
    let totalAmount = 0;
    const resolved = [];

    for (let index = 0; index < items.length; index += 1) {
      const line = items[index];
      const qty = Math.max(1, Number(line.quantity) || 1);
      const product = await tx.product.findUnique({
        where: { publicId: String(line.productId) },
        include: { variants: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!product || product.isActiveListing === false) {
        throw new AppError(404, `Product not found for line ${index + 1}`);
      }

      let variantId = null;
      let unitPrice = Number(product.price);

      if (line.variantId || (product.variants && product.variants.length > 0)) {
        const variant = line.variantId
          ? product.variants.find((v) => v.publicId === String(line.variantId))
          : product.variants[0];
        if (!variant) throw new AppError(400, `Variant not found for line ${index + 1}`);
        variantId = variant.id;
        unitPrice = Number(variant.priceOverride ?? product.price);
        const available = Number(variant.stock) - Number(variant.reservedStock || 0);
        if (available < qty) {
          throw new AppError(400, `Insufficient stock for ${product.name}`);
        }
        await tx.productVariant.update({
          where: { id: variant.id },
          data: { stock: { decrement: qty } },
        });
      } else {
        const stock = Number(product.stock ?? 0);
        if (stock < qty) {
          throw new AppError(400, `Insufficient stock for ${product.name}`);
        }
        await tx.product.update({
          where: { id: product.id },
          data: { stock: { decrement: qty } },
        });
      }

      totalAmount += unitPrice * qty;
      resolved.push({ product, variantId, qty, unitPrice });
    }

    const created = await tx.order.create({
      data: {
        userId: customer.id,
        orderNumber: placeholderOrderNumber(),
        totalAmount,
        paymentStatus: 'PAID',
        status: 'CONFIRMED',
        fulfillmentStatus: 'NEW_ORDER',
        notes: payload.notes
          ? String(payload.notes).slice(0, 500)
          : `Admin-created by ${actor.email}`,
        orderItems: {
          create: resolved.map((r) => ({
            productId: r.product.id,
            productVariantId: r.variantId,
            quantity: r.qty,
            price: r.unitPrice,
          })),
        },
      },
      select: { id: true, publicId: true },
    });
    await assignOrderNumber(tx, created.id);
    return tx.order.findUnique({
      where: { id: created.id },
      include: {
        orderItems: { include: { product: { select: { publicId: true, name: true, sku: true } } } },
        user: { select: { publicId: true, email: true, firstName: true, lastName: true } },
      },
    });
  });

  await writeAdminAudit({
    actorId: actorPublicId,
    action: 'ADMIN_ORDER_CREATED',
    entityType: 'Order',
    entityId: order.publicId,
    meta: { customerEmail: email, itemCount: items.length, totalAmount: order.totalAmount },
  });

  return order;
}
