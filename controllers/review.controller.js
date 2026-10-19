import {
  createProductReview,
  deleteOwnProductReview,
  getAdminProductReview,
  getProductReviewEligibility,
  listAdminProductReviews,
  listProductReviewsPublic,
  rejectProductReview,
  removeProductReviewAdmin,
  updateProductReview,
} from '../services/product-review.service.js';
import {
  createPlatformReview,
  exportAdminPlatformReviewsCsv,
  getAdminPlatformReview,
  getPlatformReviewEligibility,
  listAdminPlatformReviews,
  updatePlatformReview,
} from '../services/platform-review.service.js';
import { validate } from '../utils/validation.js';
import { verifyUploadedImage } from '../utils/product-upload.js';
import {
  createPlatformReviewSchema,
  createProductReviewSchema,
  updatePlatformReviewSchema,
  updateProductReviewSchema,
} from '../schemas/index.js';

export const reviewController = {
  async listProductPublic(req, res) {
    const data = await listProductReviewsPublic(req.params.id, req.query);
    res.status(200).json({ success: true, data });
  },

  async productEligibility(req, res) {
    const data = await getProductReviewEligibility(req.user, req.params.id);
    res.status(200).json({ success: true, data });
  },

  async createProduct(req, res) {
    const body = await validate(createProductReviewSchema, req.body ?? {});
    const data = await createProductReview(req.user, body);
    res.status(201).json({ success: true, data });
  },

  async updateProduct(req, res) {
    const body = await validate(updateProductReviewSchema, req.body ?? {});
    const data = await updateProductReview(req.user, req.params.id, body);
    res.status(200).json({ success: true, data });
  },

  async deleteProduct(req, res) {
    const data = await deleteOwnProductReview(req.user, req.params.id);
    res.status(200).json({ success: true, data });
  },

  async uploadProductReviewImage(req, res) {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Image file is required' });
    }
    verifyUploadedImage(req.file);
    const path = `/uploads/reviews/${req.file.filename}`;
    res.status(201).json({ success: true, data: { path, url: path } });
  },

  async adminListProducts(req, res) {
    const data = await listAdminProductReviews(req.query);
    res.status(200).json({ success: true, data });
  },

  async adminGetProduct(req, res) {
    const data = await getAdminProductReview(req.params.id);
    res.status(200).json({ success: true, data });
  },

  async adminRejectProduct(req, res) {
    const data = await rejectProductReview(req.user, req.params.id);
    res.status(200).json({ success: true, data });
  },

  async adminRemoveProduct(req, res) {
    const data = await removeProductReviewAdmin(req.user, req.params.id);
    res.status(200).json({ success: true, data });
  },

  async platformEligibility(req, res) {
    const data = await getPlatformReviewEligibility(req.user);
    res.status(200).json({ success: true, data });
  },

  async createPlatform(req, res) {
    const body = await validate(createPlatformReviewSchema, req.body ?? {});
    const data = await createPlatformReview(req.user, body);
    res.status(201).json({ success: true, data });
  },

  async updatePlatform(req, res) {
    const body = await validate(updatePlatformReviewSchema, req.body ?? {});
    const data = await updatePlatformReview(req.user, req.params.id, body);
    res.status(200).json({ success: true, data });
  },

  async adminListPlatform(req, res) {
    const data = await listAdminPlatformReviews(req.query);
    res.status(200).json({ success: true, data });
  },

  async adminGetPlatform(req, res) {
    const data = await getAdminPlatformReview(req.params.id);
    res.status(200).json({ success: true, data });
  },

  async adminExportPlatform(req, res) {
    const csv = await exportAdminPlatformReviewsCsv();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="platform-reviews.csv"');
    res.status(200).send(csv);
  },
};
