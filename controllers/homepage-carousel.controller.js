import { config } from '../config/env.js';
import { verifyUploadedImage } from '../utils/product-upload.js';
import {
  listAdminHomepageCarousel,
  getAdminHomepageCarouselSlide,
  createHomepageCarouselSlide,
  updateHomepageCarouselSlide,
  deleteHomepageCarouselSlide,
  hardDeleteHomepageCarouselSlide,
  reorderHomepageCarousel,
  searchProductsForCarousel,
} from '../services/homepage-carousel.service.js';

function resolvePublicBaseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get('host');
  return `${protocol}://${host}`.replace(/\/$/, '');
}

export const homepageCarouselController = {
  async list(_req, res) {
    const data = await listAdminHomepageCarousel();
    res.status(200).json({ success: true, data });
  },

  async get(req, res) {
    const data = await getAdminHomepageCarouselSlide(req.params.id);
    res.status(200).json({ success: true, data });
  },

  async create(req, res) {
    const data = await createHomepageCarouselSlide(req.user, req.body);
    res.status(201).json({ success: true, data });
  },

  async update(req, res) {
    const data = await updateHomepageCarouselSlide(req.user, req.params.id, req.body);
    res.status(200).json({ success: true, data });
  },

  async deactivate(req, res) {
    const data = await deleteHomepageCarouselSlide(req.user, req.params.id);
    res.status(200).json({ success: true, data });
  },

  async remove(req, res) {
    const data = await hardDeleteHomepageCarouselSlide(req.user, req.params.id);
    res.status(200).json({ success: true, data });
  },

  async reorder(req, res) {
    const data = await reorderHomepageCarousel(req.user, req.body?.orderedIds);
    res.status(200).json({ success: true, data });
  },

  async searchProducts(req, res) {
    const data = await searchProductsForCarousel(req.query.q, req.query.limit);
    res.status(200).json({ success: true, data });
  },

  async uploadImage(req, res) {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image uploaded' });
    }
    verifyUploadedImage(req.file);
    const path = `/uploads/marketing/${req.file.filename}`;
    const url = `${resolvePublicBaseUrl(req)}${path}`;
    // Prefer storing `path` (relative) in DB; `url` is for immediate admin preview.
    res.status(201).json({ success: true, data: { url, path } });
  },
};
