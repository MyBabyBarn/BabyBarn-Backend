import { orderService } from '../services/order.service.js';
import { validate } from '../utils/validation.js';
import {
  createOrderSchema,
  checkoutQuoteSchema,
  cartValidateSchema,
  trackingUpdateSchema,
  orderStatusUpdateSchema,
  adminShippingUpdateSchema,
  adminShippingOptionsSchema,
  adminGenerateLabelSchema,
  adminBulkUpsLabelsSchema,
  cancelOrderRequestSchema,
  guestCancelOrderSchema,
  orderCancellationReviewSchema,
  orderFulfillmentActionSchema,
  orderBulkFulfillmentSchema,
  pickupListCreateSchema,
  orderItemPickSchema,
} from '../schemas/index.js';
import { toPublicJson } from '../utils/serialize.js';
import { createAdminPlacedOrder } from '../services/admin-create-order.service.js';

function adminActor(req) {
  return { id: req.user?.id, email: req.user?.email };
}

export class OrderController {
  async createAdminOrder(req, res) {
    const data = await createAdminPlacedOrder(req.user.id, req.body || {});
    res.status(201).json({ success: true, data: toPublicJson(data) });
  }

  async getUserOrders(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(parseInt(String(req.query.limit), 10) || 10, 100);
    const tab = req.query.tab ? String(req.query.tab) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;
    const periodMonths = req.query.periodMonths ? String(req.query.periodMonths) : undefined;

    const result = await orderService.getUserOrders(req.user.id, page, limit, {
      tab,
      search,
      periodMonths,
    });

    res.status(200).json({
      success: true,
      data: toPublicJson(result),
    });
  }

  async getUserOrderStats(req, res) {
    const periodMonths = req.query.periodMonths ? String(req.query.periodMonths) : '12';
    const data = await orderService.getUserOrderStats(req.user.id, { periodMonths });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getCheckoutQuote(req, res) {
    const body = await validate(checkoutQuoteSchema, req.body);
    const data = await orderService.calculateCheckoutQuote(req.user.id, body);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async validateCart(req, res) {
    const body = await validate(cartValidateSchema, req.body ?? {});
    const { validateCartLines } = await import('../services/cart-validation.service.js');
    const data = await validateCartLines(body.items || [], { mode: body.mode || 'sanitize' });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getOrderById(req, res) {
    const { id } = req.params;
    const order = await orderService.getOrderById(id, req.user.id);

    res.status(200).json({
      success: true,
      data: toPublicJson(order),
    });
  }

  async trackOrder(req, res) {
    const token = req.query.token ? String(req.query.token) : undefined;
    const orderNumber = req.query.orderNumber ? String(req.query.orderNumber) : undefined;
    const email = req.query.email ? String(req.query.email) : undefined;
    const data = await orderService.trackPublicOrder({ token, orderNumber, email });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async cancelGuestOrder(req, res) {
    const body = await validate(guestCancelOrderSchema, req.body ?? {});
    const result = await orderService.cancelOrderByGuest(body);
    const partial = Boolean(result.partial);
    const message = result.isPaid
      ? partial
        ? 'Selected items have been cancelled. A partial refund has been initiated and may take 5–10 business days to appear.'
        : 'Your order has been cancelled. A refund has been initiated and may take 5–10 business days to appear.'
      : partial
        ? 'Selected items have been cancelled.'
        : 'Your order has been cancelled.';
    res.status(200).json({
      success: true,
      message,
      data: toPublicJson(result.order),
    });
  }

  async createOrder(req, res) {
    const { config } = await import('../config/env.js');
    if (config.nodeEnv === 'production') {
      const { AppError } = await import('../utils/error-handler.js');
      throw new AppError(
        410,
        'Direct order creation is disabled. Use checkout and payment.',
        'USE_CHECKOUT'
      );
    }
    const data = await validate(createOrderSchema, req.body);
    const order = await orderService.createOrder(req.user.id, data.items);

    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      data: toPublicJson(order),
    });
  }

  async getAllOrders(req, res) {
    const page = parseInt(String(req.query.page), 10) || 1;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 20, 1), 100);
    const search = req.query.search ? String(req.query.search) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined;
    const cancellationReviewStatus = req.query.cancellationReviewStatus
      ? String(req.query.cancellationReviewStatus)
      : undefined;

    const sortBy = req.query.sortBy ? String(req.query.sortBy) : undefined;
    const sortOrder = req.query.sortOrder ? String(req.query.sortOrder) : undefined;
    const membershipFilter = req.query.membershipFilter
      ? String(req.query.membershipFilter)
      : undefined;
    const statusGroup = req.query.statusGroup ? String(req.query.statusGroup) : undefined;

    const fulfillmentStatus = req.query.fulfillmentStatus ? String(req.query.fulfillmentStatus) : undefined;

    const result = await orderService.getAllOrders(page, limit, {
      search,
      status,
      statusGroup,
      dateFrom,
      dateTo,
      cancellationReviewStatus,
      membershipFilter,
      sortBy,
      sortOrder,
      fulfillmentStatus,
    });

    res.status(200).json({
      success: true,
      data: toPublicJson(result),
    });
  }

  async getAdminOrderStats(req, res) {
    const data = await orderService.getAdminOrderStats();
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getOrderAdmin(req, res) {
    const { id } = req.params;
    const order = await orderService.getOrderForAdmin(id);
    res.status(200).json({
      success: true,
      data: toPublicJson(order),
    });
  }

  async getCancellationPreview(req, res) {
    const { id } = req.params;
    const itemPublicIds = req.query.itemIds
      ? String(req.query.itemIds)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    const data = await orderService.getCancellationPreview(id, { itemPublicIds });
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async updateOrderStatus(req, res) {
    const { id } = req.params;
    const { status } = await validate(orderStatusUpdateSchema, req.body);

    const order = await orderService.updateOrderStatus(id, status, adminActor(req));

    res.status(200).json({
      success: true,
      message:
        status === 'CANCELLED'
          ? 'Order cancelled successfully'
          : 'Order status updated successfully',
      data: toPublicJson(order),
    });
  }

  async refundOrder(req, res) {
    const { id } = req.params;
    const order = await orderService.refundOrder(id, adminActor(req));
    res.status(200).json({
      success: true,
      message: 'Order marked as refunded',
      data: toPublicJson(order),
    });
  }

  async updateAdminShipping(req, res) {
    const { id } = req.params;
    const body = await validate(adminShippingUpdateSchema, req.body);
    const order = await orderService.updateAdminShipping(id, body, adminActor(req));
    res.status(200).json({ success: true, data: toPublicJson(order) });
  }

  async updateTracking(req, res) {
    const { id } = req.params;
    const body = await validate(trackingUpdateSchema, req.body);
    const order = await orderService.addTracking(id, body, adminActor(req));
    res.status(200).json({ success: true, data: toPublicJson(order) });
  }

  async getOrderActivity(req, res) {
    const { id } = req.params;
    const { listOrderActivity } = await import('../services/audit.service.js');
    const data = await listOrderActivity(id);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getAdminShippingOptions(req, res) {
    const { id } = req.params;
    const body = await validate(adminShippingOptionsSchema, req.body ?? {});
    const data = await orderService.getAdminShippingOptions(id, body);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async generateAdminShippingLabel(req, res) {
    const { id } = req.params;
    const body = await validate(adminGenerateLabelSchema, req.body ?? {});
    const data = await orderService.generateAdminShippingLabel(id, body, adminActor(req));
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async generateAdminUpsLabel(req, res) {
    const { id } = req.params;
    const data = await orderService.generateAdminUpsLabel(id, adminActor(req));
    res.status(200).json({
      success: true,
      message: 'UPS label generated',
      data: toPublicJson(data),
    });
  }

  async bulkGenerateAdminUpsLabels(req, res) {
    const body = await validate(adminBulkUpsLabelsSchema, req.body);
    const data = await orderService.bulkGenerateAdminUpsLabels(body.orderPublicIds, adminActor(req));
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async downloadAdminLabelsZip(req, res, next) {
    try {
      const ids = String(req.query.ids || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!ids.length) {
        return res.status(400).json({ success: false, message: 'ids query required' });
      }
      await orderService.streamLabelsZip(res, ids);
    } catch (e) {
      next(e);
    }
  }

  async getAdminReturnShippingOptions(req, res) {
    const { id } = req.params;
    const body = await validate(adminShippingOptionsSchema, req.body ?? {});
    const data = await orderService.getAdminReturnShippingOptions(id, body);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async generateAdminReturnLabel(req, res) {
    const { id } = req.params;
    const body = await validate(adminGenerateLabelSchema, req.body ?? {});
    const data = await orderService.generateAdminReturnLabel(id, body, adminActor(req));
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async cancelMyOrder(req, res) {
    const { id } = req.params;
    const body = await validate(cancelOrderRequestSchema, req.body ?? {});
    const result = await orderService.cancelOrderByUser(id, req.user.id, {
      reason: body.reason,
      itemIds: body.itemIds,
    });
    const partial = Boolean(result.partial);
    const message = result.isPaid
      ? partial
        ? 'Selected items have been cancelled. A partial refund has been initiated and may take 5–10 business days to appear.'
        : 'Your order has been cancelled. A refund has been initiated and may take 5–10 business days to appear.'
      : partial
        ? 'Selected items have been cancelled.'
        : 'Your order has been cancelled.';
    res.status(200).json({
      success: true,
      message,
      data: toPublicJson(result.order),
    });
  }

  async reviewCancellation(req, res) {
    const { id } = req.params;
    const body = await validate(orderCancellationReviewSchema, req.body);
    const order = await orderService.reviewCancellationOrder(id, body, adminActor(req));
    res.status(200).json({
      success: true,
      message: `Cancellation ${body.decision === 'approve' ? 'approved' : 'rejected'}`,
      data: toPublicJson(order),
    });
  }

  async patchOrderFulfillment(req, res) {
    const { id } = req.params;
    const body = await validate(orderFulfillmentActionSchema, req.body);
    const order = await orderService.patchOrderFulfillment(id, body, adminActor(req));
    res.status(200).json({ success: true, data: toPublicJson(order) });
  }

  async pickOrderItem(req, res) {
    const { id, itemId } = req.params;
    const body = await validate(orderItemPickSchema, req.body);
    const order = await orderService.pickOrderItem(id, itemId, body, adminActor(req));
    res.status(200).json({ success: true, data: toPublicJson(order) });
  }

  async bulkOrderFulfillment(req, res) {
    const body = await validate(orderBulkFulfillmentSchema, req.body);
    const data = await orderService.bulkPatchOrderFulfillment(body, adminActor(req));
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async createPickupList(req, res) {
    const body = await validate(pickupListCreateSchema, req.body);
    const list = await orderService.createPickupList(body, adminActor(req));
    res.status(201).json({ success: true, data: toPublicJson(list) });
  }

  async getPickupListPrintData(req, res) {
    const { publicId } = req.params;
    const data = await orderService.getPickupListForPdf(publicId);
    res.status(200).json({ success: true, data: toPublicJson(data) });
  }

  async getPickupListPdf(req, res, next) {
    try {
      const { publicId } = req.params;
      const { title, orders } = await orderService.getPickupListForPdf(publicId);
      const { renderPickupListPdfBuffer } = await import('../services/pdf/order-documents.service.js');
      const buf = await renderPickupListPdfBuffer({ title, orders });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="pickup-${publicId}.pdf"`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  }

  async getOrderPdf(req, res, next) {
    try {
      const { id, kind } = req.params;
      const buf = await orderService.getOrderPdfBuffer(id, kind);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="order-${id}-${kind}.pdf"`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  }

  async getMyOrderInvoicePdf(req, res, next) {
    try {
      const { id } = req.params;
      // Ownership guard: throws 403/404 if the order is not the caller's.
      await orderService.getOrderById(id, req.user.id);
      const buf = await orderService.getOrderPdfBuffer(id, 'invoice');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="order-${id}-invoice.pdf"`);
      res.send(buf);
    } catch (e) {
      next(e);
    }
  }
}

export const orderController = new OrderController();
