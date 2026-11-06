import { Router } from 'express';
import { authenticate, authorize, requireCustomerFullAccount } from '../middleware/auth.js';
import { requireConsoleModule } from '../middleware/admin-console.js';
import { reviewController } from '../controllers/review.controller.js';
import { reviewImageUpload } from '../utils/product-upload.js';

const router = Router();

// --- Customer product reviews ---
router.post(
  '/products/upload-image',
  authenticate,
  requireCustomerFullAccount,
  (req, res, next) => {
    reviewImageUpload.single('image')(req, res, (err) => {
      if (err) return next(err);
      reviewController.uploadProductReviewImage(req, res).catch(next);
    });
  }
);
router.post(
  '/products',
  authenticate,
  requireCustomerFullAccount,
  (req, res, next) => reviewController.createProduct(req, res).catch(next)
);
router.patch(
  '/products/:id',
  authenticate,
  requireCustomerFullAccount,
  (req, res, next) => reviewController.updateProduct(req, res).catch(next)
);
router.delete(
  '/products/:id',
  authenticate,
  requireCustomerFullAccount,
  (req, res, next) => reviewController.deleteProduct(req, res).catch(next)
);

// --- Customer platform reviews ---
router.get(
  '/platform/eligibility',
  authenticate,
  requireCustomerFullAccount,
  (req, res, next) => reviewController.platformEligibility(req, res).catch(next)
);
router.post(
  '/platform',
  authenticate,
  requireCustomerFullAccount,
  (req, res, next) => reviewController.createPlatform(req, res).catch(next)
);
router.patch(
  '/platform/:id',
  authenticate,
  requireCustomerFullAccount,
  (req, res, next) => reviewController.updatePlatform(req, res).catch(next)
);

// --- Admin ---
router.get(
  '/admin/products',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminListProducts(req, res).catch(next)
);
router.post(
  '/admin/products/bulk-hide',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminBulkHideProducts(req, res).catch(next)
);
router.post(
  '/admin/products/bulk-restore',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminBulkRestoreProducts(req, res).catch(next)
);
router.get(
  '/admin/products/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminGetProduct(req, res).catch(next)
);
router.post(
  '/admin/products/:id/reject',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminRejectProduct(req, res).catch(next)
);
router.post(
  '/admin/products/:id/restore',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminRestoreProduct(req, res).catch(next)
);
router.delete(
  '/admin/products/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminRemoveProduct(req, res).catch(next)
);

router.get(
  '/admin/platform/export',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminExportPlatform(req, res).catch(next)
);
router.get(
  '/admin/platform',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminListPlatform(req, res).catch(next)
);
router.get(
  '/admin/platform/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminGetPlatform(req, res).catch(next)
);
router.post(
  '/admin/platform/:id/hide',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminHidePlatform(req, res).catch(next)
);
router.post(
  '/admin/platform/:id/restore',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('reviews'),
  (req, res, next) => reviewController.adminRestorePlatform(req, res).catch(next)
);

export default router;
