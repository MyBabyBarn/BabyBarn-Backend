import { Router } from 'express';
import { getPublicBusinessSettings } from '../services/membership.service.js';
import { listPublicHomepageCarousel } from '../services/homepage-carousel.service.js';
import { blogController } from '../controllers/blog.controller.js';
import { publicCache } from '../middleware/public-cache.js';

const router = Router();

router.use(publicCache(120));

router.get('/business-settings', async (req, res, next) => {
  try {
    const data = await getPublicBusinessSettings();
    res.status(200).json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

router.get('/blog', (req, res, next) => blogController.publicList(req, res).catch(next));
router.get('/blog/paths', (req, res, next) => blogController.publicPaths(req, res).catch(next));
router.get('/blog/category/:slug', (req, res, next) => blogController.publicCategory(req, res).catch(next));
router.get('/blog/tag/:slug', (req, res, next) => blogController.publicTag(req, res).catch(next));
router.get('/blog/:slug', (req, res, next) => blogController.publicGet(req, res).catch(next));
router.post('/blog/:slug/view', (req, res, next) => blogController.publicView(req, res).catch(next));

router.get('/homepage-carousel', async (req, res, next) => {
  try {
    const data = await listPublicHomepageCarousel();
    res.status(200).json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

export default router;
