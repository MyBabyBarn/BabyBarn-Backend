import { Router } from 'express';
import { authenticate, authorize, requireCustomerFullAccount } from '../middleware/auth.js';
import { requireConsoleModuleAny } from '../middleware/admin-console.js';

const returnsOrInspection = requireConsoleModuleAny(['returns', 'inspection']);
import { returnsController } from '../controllers/returns.controller.js';
import { returnPhotoUpload } from '../utils/product-upload.js';

const router = Router();

router.get(
  '/refurbishment/jobs',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.listRefurbJobs(req, res).catch(next)
);
router.get(
  '/refurbishment/by-return/:returnId',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.getRefurbJobByReturn(req, res).catch(next)
);
router.patch(
  '/refurbishment/:jobId/status',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.updateRefurbJobStatus(req, res).catch(next)
);
router.get(
  '/admin/all',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.listAll(req, res).catch(next)
);
router.get(
  '/admin/stats',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.getAdminListStats(req, res).catch(next)
);
router.get(
  '/admin/package-requests',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.listPackageRequestsAdmin(req, res).catch(next)
);
router.patch(
  '/admin/package-requests/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.updatePackageRequest(req, res).catch(next)
);
router.get(
  '/admin/triage',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.getTriageCursor(req, res).catch(next)
);
router.post(
  '/admin/bulk-received',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.bulkMarkReceived(req, res).catch(next)
);
router.post(
  '/admin/upload-photo',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => {
    returnPhotoUpload.single('image')(req, res, (err) => {
      if (err) return next(err);
      returnsController.uploadPhoto(req, res);
    });
  }
);
// Param route must stay after static /admin/* paths above.
router.get(
  '/admin/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.getAdminById(req, res).catch(next)
);
router.patch(
  '/:id/eligibility-review',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.reviewEligibility(req, res).catch(next)
);
router.post(
  '/:id/return-label',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.generateReturnLabel(req, res).catch(next)
);
router.post(
  '/:id/sync-tracking',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.syncReturnTracking(req, res).catch(next)
);
router.post(
  '/:id/inspection',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.createInspection(req, res).catch(next)
);
router.post(
  '/:id/keep-waiting',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.keepWaiting(req, res).catch(next)
);
router.post('/guest', (req, res, next) => returnsController.createGuest(req, res).catch(next));
router.post('/guest/track', (req, res, next) => returnsController.trackGuest(req, res).catch(next));
router.post(
  '/package-requests',
  authenticate,
  ...requireCustomerFullAccount,
  (req, res, next) => returnsController.createPackageRequest(req, res).catch(next)
);
router.get(
  '/package-requests/mine',
  authenticate,
  ...requireCustomerFullAccount,
  (req, res, next) => returnsController.listPackageRequestsMine(req, res).catch(next)
);
router.get('/', authenticate, ...requireCustomerFullAccount, (req, res, next) => returnsController.listMine(req, res).catch(next));
router.post('/upload-photo', authenticate, ...requireCustomerFullAccount, (req, res, next) => {
  returnPhotoUpload.single('image')(req, res, (err) => {
    if (err) return next(err);
    returnsController.uploadPhoto(req, res);
  });
});
router.get('/:id', authenticate, ...requireCustomerFullAccount, (req, res, next) => returnsController.getMineById(req, res).catch(next));
router.post(
  '/:id/usps-shipment',
  authenticate,
  ...requireCustomerFullAccount,
  (req, res, next) => returnsController.submitUspsShipment(req, res).catch(next)
);
router.post(
  '/:id/cancel',
  authenticate,
  ...requireCustomerFullAccount,
  (req, res, next) => returnsController.cancelReturn(req, res).catch(next)
);
router.post('/', authenticate, ...requireCustomerFullAccount, (req, res, next) => returnsController.create(req, res).catch(next));
router.patch(
  '/:id/status',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.updateStatus(req, res).catch(next)
);
router.patch(
  '/:id/inspect-line',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.inspectLine(req, res).catch(next)
);
router.post(
  '/:id/receive-package',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.receivePackage(req, res).catch(next)
);
router.post(
  '/:id/refund',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.processRefund(req, res).catch(next)
);
router.post(
  '/:id/restock',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.restockReturn(req, res).catch(next)
);
router.post(
  '/:id/approve-and-settle',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  returnsOrInspection,
  (req, res, next) => returnsController.approveAndSettle(req, res).catch(next)
);

export default router;
