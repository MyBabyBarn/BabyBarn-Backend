import { Router } from 'express';
import { productController } from '../controllers/product.controller.js';
import { productUploadController } from '../controllers/product-upload.controller.js';
import { categoryController } from '../controllers/category.controller.js';
import { reviewController } from '../controllers/review.controller.js';
import { authenticate, authorize, requireCustomerFullAccount } from '../middleware/auth.js';
import { requireConsoleModule, requireConsoleModuleAny } from '../middleware/admin-console.js';
import { publicCache } from '../middleware/public-cache.js';
import { productImageUpload } from '../utils/product-upload.js';

const router = Router();

router.get('/', publicCache(60), (req, res, next) => productController.getAllProducts(req, res).catch(next));

router.get(
  '/admin',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('products'),
  (req, res, next) => productController.getAllProductsAdmin(req, res).catch(next)
);
router.get(
  '/admin/refurbished/source-candidates',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('refurbished'),
  (req, res, next) => productController.getRefurbSourceCandidates(req, res).catch(next)
);
router.post(
  '/admin/refurbished/from-source',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('refurbished'),
  (req, res, next) => productController.createRefurbFromSource(req, res).catch(next)
);
router.post(
  '/admin/refurbished/standalone',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('refurbished'),
  (req, res, next) => productController.createStandaloneRefurb(req, res).catch(next)
);
router.get(
  '/admin/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('products'),
  (req, res, next) => productController.getProductByIdAdmin(req, res).catch(next)
);

// Read-only category tree stays available to product managers (needed by the
// product create/edit forms); only mutations are ADMIN-only.
router.get(
  '/categories/tree',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModuleAny(['categories', 'products', 'refurbished']),
  (req, res, next) => categoryController.getTree(req, res).catch(next)
);
router.get('/categories', publicCache(120), (req, res, next) => productController.getAllCategories(req, res).catch(next));
router.post(
  '/categories',
  authenticate,
  authorize('ADMIN'),
  (req, res, next) => categoryController.create(req, res).catch(next)
);
router.put(
  '/categories/:id',
  authenticate,
  authorize('ADMIN'),
  (req, res, next) => categoryController.update(req, res).catch(next)
);
router.patch(
  '/categories/:id/status',
  authenticate,
  authorize('ADMIN'),
  (req, res, next) => categoryController.patchStatus(req, res).catch(next)
);
router.delete(
  '/categories/:id',
  authenticate,
  authorize('ADMIN'),
  (req, res, next) => categoryController.remove(req, res).catch(next)
);

router.get(
  '/:id/reviews',
  publicCache(60),
  (req, res, next) => reviewController.listProductPublic(req, res).catch(next)
);
router.get(
  '/:id/reviews/eligibility',
  authenticate,
  requireCustomerFullAccount,
  (req, res, next) => reviewController.productEligibility(req, res).catch(next)
);

router.get('/:id', publicCache(30), (req, res, next) => productController.getProductById(req, res).catch(next));

router.post('/upload-image', authenticate, authorize('ADMIN', 'ADMIN_TEAM'), requireConsoleModule('products'), (req, res, next) => {
  productImageUpload.single('image')(req, res, (err) => {
    if (err) return next(err);
    productUploadController.uploadProductImage(req, res);
  });
});

router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('products'),
  (req, res, next) => productController.createProduct(req, res).catch(next)
);
router.put(
  '/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('products'),
  (req, res, next) => productController.updateProduct(req, res).catch(next)
);
router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN', 'ADMIN_TEAM'),
  requireConsoleModule('products'),
  (req, res, next) => productController.deleteProduct(req, res).catch(next)
);

export default router;
