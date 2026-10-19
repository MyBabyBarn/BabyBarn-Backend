import { config } from '../config/env.js';
import { verifyUploadedImage } from '../utils/product-upload.js';
import {
  blogAnalytics,
  createCategory,
  createPost,
  createTag,
  deleteCategory,
  deletePost,
  deleteTag,
  duplicatePost,
  getAdminPost,
  getPublicPost,
  getPublicTaxonomy,
  listAdminPosts,
  listPublicPaths,
  listCategories,
  listPublicBlog,
  listTags,
  publishPost,
  recordPublicView,
  schedulePost,
  setFeatured,
  unpublishPost,
  updateCategory,
  updatePost,
  updateTag,
} from '../services/blog.service.js';

function resolvePublicBaseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const protocol = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
  const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host');
  return `${protocol}://${host}`.replace(/\/$/, '');
}

export const blogController = {
  async list(req, res) {
    const data = await listAdminPosts(req.query);
    res.status(200).json({ success: true, data });
  },
  async analytics(_req, res) {
    const data = await blogAnalytics();
    res.status(200).json({ success: true, data });
  },
  async get(req, res) {
    const data = await getAdminPost(req.params.id);
    res.status(200).json({ success: true, data });
  },
  async create(req, res) {
    const data = await createPost(req.user, req.body ?? {});
    res.status(201).json({ success: true, data });
  },
  async update(req, res) {
    const data = await updatePost(req.user, req.params.id, req.body ?? {});
    res.status(200).json({ success: true, data });
  },
  async remove(req, res) {
    const data = await deletePost(req.user, req.params.id);
    res.status(200).json({ success: true, data });
  },
  async duplicate(req, res) {
    const data = await duplicatePost(req.user, req.params.id);
    res.status(201).json({ success: true, data });
  },
  async publish(req, res) {
    const data = await publishPost(req.user, req.params.id);
    res.status(200).json({ success: true, data });
  },
  async unpublish(req, res) {
    const data = await unpublishPost(req.user, req.params.id);
    res.status(200).json({ success: true, data });
  },
  async schedule(req, res) {
    const data = await schedulePost(req.user, req.params.id, req.body?.scheduledAt);
    res.status(200).json({ success: true, data });
  },
  async feature(req, res) {
    const data = await setFeatured(req.user, req.params.id, req.body?.featured);
    res.status(200).json({ success: true, data });
  },
  async uploadImage(req, res) {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'No image uploaded' });
      return;
    }
    verifyUploadedImage(req.file);
    const path = `/uploads/marketing/${req.file.filename}`;
    const url = `${resolvePublicBaseUrl(req)}${path}`;
    res.status(201).json({ success: true, data: { url, path } });
  },
  async listCategories(_req, res) {
    res.status(200).json({ success: true, data: await listCategories() });
  },
  async createCategory(req, res) {
    res.status(201).json({ success: true, data: await createCategory(req.user, req.body ?? {}) });
  },
  async updateCategory(req, res) {
    res.status(200).json({ success: true, data: await updateCategory(req.user, req.params.id, req.body ?? {}) });
  },
  async deleteCategory(req, res) {
    await deleteCategory(req.user, req.params.id);
    res.status(200).json({ success: true });
  },
  async listTags(_req, res) {
    res.status(200).json({ success: true, data: await listTags() });
  },
  async createTag(req, res) {
    res.status(201).json({ success: true, data: await createTag(req.user, req.body ?? {}) });
  },
  async updateTag(req, res) {
    res.status(200).json({ success: true, data: await updateTag(req.user, req.params.id, req.body ?? {}) });
  },
  async deleteTag(req, res) {
    await deleteTag(req.user, req.params.id);
    res.status(200).json({ success: true });
  },
  async publicList(req, res) {
    res.status(200).json({ success: true, data: await listPublicBlog(req.query) });
  },
  async publicPaths(_req, res) {
    res.status(200).json({ success: true, data: await listPublicPaths() });
  },
  async publicCategory(req, res) {
    res.status(200).json({ success: true, data: await getPublicTaxonomy('category', req.params.slug, req.query) });
  },
  async publicTag(req, res) {
    res.status(200).json({ success: true, data: await getPublicTaxonomy('tag', req.params.slug, req.query) });
  },
  async publicGet(req, res) {
    res.status(200).json({ success: true, data: await getPublicPost(req.params.slug) });
  },
  async publicView(req, res) {
    const result = await recordPublicView(req.params.slug, req.headers.cookie, req.headers['x-blog-seen']);
    if (result.setCookie) res.setHeader('Set-Cookie', result.setCookie);
    res.status(200).json({ success: true, data: { counted: result.counted } });
  },
};
