import { Router } from 'express';
import { orderController } from '../controllers/order.controller.js';
import { authenticate, authorize, requireCustomerFullAccount } from '../middleware/auth.js';
import {
  requireConsoleModule,
  requireConsoleModuleAny,
  requireTeamAction,
} from '../middleware/admin-console.js';

const router = Router();
const ordersOrShipping = requireConsoleModuleAny(['orders', 'shipping']);

router.get('/track', (req, res, next) => orderController.trackOrder(req, res).catch(next));
router.post('/guest/cancel', (req, res, next) => orderController.cancelGuestOrder(req, res).catch(next));
router.get('/', authenticate, ...requireCustomerFullAccount, (req, res, next) => orderController.getUserOrders(req, res).catch(next));
router.get('/stats', authenticate, ...requireCustomerFullAccount, (req, res, next) => orderController.getUserOrderStats(req, res).catch(next));
router.post('/', authenticate, (req, res, next) => orderController.createOrder(req, res).catch(next));
router.post('/cart/validate', (req, res, next) => orderController.validateCart(req, res).catch(next));
router.post('/quote', authenticate, (req, res, next) => orderController.getCheckoutQuote(req, res).catch(next));

router.post(
  '/admin/create',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  requireTeamAction('order-management', 'create'),
  (req, res, next) => orderController.createAdminOrder(req, res).catch(next)
);
router.get(
  '/admin/all',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.getAllOrders(req, res).catch(next)
);
router.get(
  '/admin/stats',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.getAdminOrderStats(req, res).catch(next)
);
router.post(
  '/admin/bulk/fulfillment',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.bulkOrderFulfillment(req, res).catch(next)
);
router.post(
  '/admin/pickup-lists',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.createPickupList(req, res).catch(next)
);
router.get(
  '/admin/pickup-lists/:publicId',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.getPickupListPrintData(req, res).catch(next)
);
router.get(
  '/admin/pickup-lists/:publicId/pdf',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.getPickupListPdf(req, res, next)
);
router.patch(
  '/admin/:id/items/:itemId/pick',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.pickOrderItem(req, res).catch(next)
);
router.patch(
  '/admin/:id/fulfillment',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.patchOrderFulfillment(req, res).catch(next)
);
router.get(
  '/admin/:id/pdf/:kind',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.getOrderPdf(req, res, next)
);
router.post(
  '/admin/:id/shipping-options',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.getAdminShippingOptions(req, res).catch(next)
);
router.post(
  '/admin/:id/shipping-label',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.generateAdminShippingLabel(req, res).catch(next)
);
router.post(
  '/admin/:id/ups-label',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.generateAdminUpsLabel(req, res).catch(next)
);
router.post(
  '/admin/bulk/ups-labels',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.bulkGenerateAdminUpsLabels(req, res).catch(next)
);
router.get(
  '/admin/bulk/labels.zip',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.downloadAdminLabelsZip(req, res).catch(next)
);
router.post(
  '/admin/:id/return-options',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.getAdminReturnShippingOptions(req, res).catch(next)
);
router.post(
  '/admin/:id/return-label',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.generateAdminReturnLabel(req, res).catch(next)
);
router.get(
  '/admin/:id/cancellation-preview',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.getCancellationPreview(req, res).catch(next)
);
router.get(
  '/admin/:id/activity',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.getOrderActivity(req, res).catch(next)
);
router.get(
  '/admin/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.getOrderAdmin(req, res).catch(next)
);
router.patch(
  '/:id/status',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.updateOrderStatus(req, res).catch(next)
);
router.patch(
  '/:id/refund',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.refundOrder(req, res).catch(next)
);
router.patch(
  '/:id/shipping',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.updateAdminShipping(req, res).catch(next)
);
router.patch(
  '/:id/cancellation-review',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('orders'),
  (req, res, next) => orderController.reviewCancellation(req, res).catch(next)
);
router.patch('/:id/cancel', authenticate, (req, res, next) =>
  orderController.cancelMyOrder(req, res).catch(next)
);
router.patch(
  '/:id/tracking',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  ordersOrShipping,
  (req, res, next) => orderController.updateTracking(req, res).catch(next)
);
router.get('/:id/pdf/invoice', authenticate, ...requireCustomerFullAccount, (req, res, next) =>
  orderController.getMyOrderInvoicePdf(req, res, next)
);
router.get('/:id', authenticate, ...requireCustomerFullAccount, (req, res, next) =>
  orderController.getOrderById(req, res).catch(next)
);

export default router;
