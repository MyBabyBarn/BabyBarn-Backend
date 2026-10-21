import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { requireConsoleModule } from '../middleware/admin-console.js';
import { adminController } from '../controllers/admin.controller.js';
import { shippingAdminController } from '../controllers/shipping-admin.controller.js';
import { homepageCarouselController } from '../controllers/homepage-carousel.controller.js';
import { blogController } from '../controllers/blog.controller.js';
import { marketingImageUpload } from '../utils/product-upload.js';
import adminNotificationsRoutes from './admin-notifications.js';
import {
  getAdminShareDetail,
  getSharingSettings,
  listAdminSharing,
  listAdminSharingActivity,
  updateSharingSettings,
} from '../services/membership-sharing.service.js';

const router = Router();
const homepage = requireConsoleModule('homepage');
const blog = requireConsoleModule('blog');
const blogStaff = [authenticate, authorize('ADMIN', 'ADMIN_TEAM'), blog];

router.use('/notifications', adminNotificationsRoutes);

router.get(
  '/dashboard/overview',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  (req, res, next) => adminController.getDashboardOverview(req, res).catch(next)
);
router.get(
  '/finance/stats',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('finance'),
  (req, res, next) => adminController.getFinanceStats(req, res).catch(next)
);
router.get(
  '/finance/transactions',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('finance'),
  (req, res, next) => adminController.listFinanceTransactions(req, res).catch(next)
);
router.get(
  '/store-credit/activity',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('store-credit'),
  (req, res, next) => adminController.listStoreCreditActivity(req, res).catch(next)
);
router.get(
  '/audit-logs/export',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('activity'),
  (req, res, next) => adminController.exportAuditLogs(req, res).catch(next)
);
router.get(
  '/audit-logs',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('activity'),
  (req, res, next) => adminController.listAuditLogs(req, res).catch(next)
);
router.get(
  '/customers',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('customers'),
  (req, res, next) => adminController.listCustomers(req, res).catch(next)
);
router.get(
  '/customers/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('customers'),
  (req, res, next) => adminController.getCustomer(req, res).catch(next)
);
router.patch(
  '/customers/:id/active',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('customers'),
  (req, res, next) => adminController.patchCustomerActive(req, res).catch(next)
);
router.get(
  '/access/members',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('access'),
  (req, res, next) => adminController.listAccessMembers(req, res).catch(next)
);
router.get(
  '/access/sharing',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('access'),
  async (req, res, next) => {
    try {
      const [settings, memberships, activity] = await Promise.all([
        getSharingSettings(),
        listAdminSharing(),
        listAdminSharingActivity(),
      ]);
      res.status(200).json({ success: true, data: { settings, memberships, activity } });
    } catch (error) {
      next(error);
    }
  }
);
router.get(
  '/access/sharing/:userId',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('access'),
  async (req, res, next) => {
    try {
      const data = await getAdminShareDetail(req.params.userId);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);
router.patch(
  '/access/sharing',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('access'),
  async (req, res, next) => {
    try {
      const data = await updateSharingSettings(req.user, req.body || {});
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
);
router.get(
  '/settings/business',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('access'),
  (req, res, next) => adminController.getBusinessSettings(req, res).catch(next)
);
router.patch(
  '/settings/business',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('access'),
  (req, res, next) => adminController.patchBusinessSettings(req, res).catch(next)
);

router.get(
  '/shipping/config',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('shipping'),
  (req, res, next) => shippingAdminController.getConfig(req, res).catch(next)
);
router.put(
  '/shipping/config',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('shipping'),
  (req, res, next) => shippingAdminController.putConfig(req, res).catch(next)
);
router.post(
  '/shipping/services',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('shipping'),
  (req, res, next) => shippingAdminController.createService(req, res).catch(next)
);
router.patch(
  '/shipping/services/:publicId',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('shipping'),
  (req, res, next) => shippingAdminController.patchService(req, res).catch(next)
);
router.delete(
  '/shipping/services/:publicId',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('shipping'),
  (req, res, next) => shippingAdminController.deleteService(req, res).catch(next)
);
router.get(
  '/shipping/logs',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('shipping'),
  (req, res, next) => shippingAdminController.listLogs(req, res).catch(next)
);
router.post(
  '/shipping/test-ups',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('shipping'),
  (req, res, next) => shippingAdminController.testUps(req, res).catch(next)
);

router.get(
  '/homepage-carousel',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  homepage,
  (req, res, next) => homepageCarouselController.list(req, res).catch(next)
);
router.get(
  '/homepage-carousel/product-search',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  homepage,
  (req, res, next) => homepageCarouselController.searchProducts(req, res).catch(next)
);
router.put(
  '/homepage-carousel/reorder',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  homepage,
  (req, res, next) => homepageCarouselController.reorder(req, res).catch(next)
);
router.post(
  '/homepage-carousel/upload-image',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  homepage,
  marketingImageUpload.single('image'),
  (req, res, next) => homepageCarouselController.uploadImage(req, res).catch(next)
);
router.post(
  '/homepage-carousel',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  homepage,
  (req, res, next) => homepageCarouselController.create(req, res).catch(next)
);
router.get(
  '/homepage-carousel/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  homepage,
  (req, res, next) => homepageCarouselController.get(req, res).catch(next)
);
router.patch(
  '/homepage-carousel/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  homepage,
  (req, res, next) => homepageCarouselController.update(req, res).catch(next)
);
router.delete(
  '/homepage-carousel/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  homepage,
  (req, res, next) => homepageCarouselController.deactivate(req, res).catch(next)
);
router.delete(
  '/homepage-carousel/:id/hard',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  homepage,
  (req, res, next) => homepageCarouselController.remove(req, res).catch(next)
);

router.get('/blog/analytics', ...blogStaff, (req, res, next) => blogController.analytics(req, res).catch(next));
router.get('/blog/categories', ...blogStaff, (req, res, next) => blogController.listCategories(req, res).catch(next));
router.post('/blog/categories', ...blogStaff, (req, res, next) => blogController.createCategory(req, res).catch(next));
router.patch('/blog/categories/:id', ...blogStaff, (req, res, next) => blogController.updateCategory(req, res).catch(next));
router.delete('/blog/categories/:id', ...blogStaff, (req, res, next) => blogController.deleteCategory(req, res).catch(next));
router.get('/blog/tags', ...blogStaff, (req, res, next) => blogController.listTags(req, res).catch(next));
router.post('/blog/tags', ...blogStaff, (req, res, next) => blogController.createTag(req, res).catch(next));
router.patch('/blog/tags/:id', ...blogStaff, (req, res, next) => blogController.updateTag(req, res).catch(next));
router.delete('/blog/tags/:id', ...blogStaff, (req, res, next) => blogController.deleteTag(req, res).catch(next));
router.post(
  '/blog/upload-image',
  ...blogStaff,
  marketingImageUpload.single('image'),
  (req, res, next) => blogController.uploadImage(req, res).catch(next)
);
router.get('/blog', ...blogStaff, (req, res, next) => blogController.list(req, res).catch(next));
router.post('/blog', ...blogStaff, (req, res, next) => blogController.create(req, res).catch(next));
router.post('/blog/:id/duplicate', ...blogStaff, (req, res, next) => blogController.duplicate(req, res).catch(next));
router.post('/blog/:id/publish', ...blogStaff, (req, res, next) => blogController.publish(req, res).catch(next));
router.post('/blog/:id/unpublish', ...blogStaff, (req, res, next) => blogController.unpublish(req, res).catch(next));
router.post('/blog/:id/schedule', ...blogStaff, (req, res, next) => blogController.schedule(req, res).catch(next));
router.post('/blog/:id/feature', ...blogStaff, (req, res, next) => blogController.feature(req, res).catch(next));
router.get('/blog/:id', ...blogStaff, (req, res, next) => blogController.get(req, res).catch(next));
router.patch('/blog/:id', ...blogStaff, (req, res, next) => blogController.update(req, res).catch(next));
router.delete('/blog/:id', ...blogStaff, (req, res, next) => blogController.remove(req, res).catch(next));

router.get('/team', authenticate, authorize('ADMIN'), (req, res, next) =>
  adminController.listTeam(req, res).catch(next)
);
router.post('/team', authenticate, authorize('ADMIN'), (req, res, next) =>
  adminController.createTeamMember(req, res).catch(next)
);
router.patch('/team/:id/modules', authenticate, authorize('ADMIN'), (req, res, next) =>
  adminController.patchTeamModules(req, res).catch(next)
);
router.patch('/team/:id', authenticate, authorize('ADMIN'), (req, res, next) =>
  adminController.updateTeamMember(req, res).catch(next)
);

export default router;
