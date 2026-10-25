/**
 * SCL-01: short CDN/browser cache for anonymous catalog/content reads.
 * Skip when Authorization is present so personalised responses stay private.
 */
export function publicCache(maxAgeSeconds = 60) {
  const maxAge = Math.max(0, Number(maxAgeSeconds) || 0);
  return function publicCacheMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (req.get('authorization')) {
      res.setHeader('Cache-Control', 'private, no-store');
      next();
      return;
    }
    res.setHeader(
      'Cache-Control',
      `public, max-age=${maxAge}, stale-while-revalidate=${Math.max(maxAge * 2, 30)}`
    );
    next();
  };
}
