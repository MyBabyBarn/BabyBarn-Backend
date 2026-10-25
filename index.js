import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config/env.js';
import { prisma, refreshPrismaClientIfNeeded } from './lib/prisma.js';
import { errorHandler, AppError } from './utils/error-handler.js';
import { ensureUploadDirs } from './utils/product-upload.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import orderRoutes from './routes/orders.js';
import inventoryRoutes from './routes/inventory.js';
import paymentRoutes from './routes/payments.js';
import contactRoutes from './routes/contact.js';
import returnsRoutes from './routes/returns.js';
import walletRoutes from './routes/wallet.js';
import adminRoutes from './routes/admin.js';
import shippingRoutes from './routes/shipping.js';
import publicRoutes from './routes/public.js';
import membershipRoutes from './routes/membership.js';
import checkoutRoutes from './routes/checkout.js';
import wishlistRoutes from './routes/wishlist.js';
import stockAlertsRoutes from './routes/stock-alerts.js';
import systemRoutes from './routes/system.js';
import reviewsRoutes from './routes/reviews.js';
import { primaryLanIpv4 } from './lib/lan-host.js';
import { assertPrivateUploadAccess, isPrivateUploadPath } from './lib/private-upload-access.js';
import { stripeWebhook } from './controllers/payment.controller.js';
import { startScheduledJobs } from './services/scheduled-jobs.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

ensureUploadDirs();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

/** Public product/marketing media only. Return photos and shipping labels need a session. */
app.use('/uploads', (req, res, next) => {
  void res;
  const rel = String(req.path || '').replace(/\\/g, '/');
  const lower = rel.toLowerCase();
  if (lower.includes('/../') || lower.includes('%2e%2e')) {
    return next(new AppError(403, 'Forbidden'));
  }
  if (!isPrivateUploadPath(lower)) {
    next();
    return;
  }
  assertPrivateUploadAccess(req, rel).then(() => next()).catch(next);
});
app.use(
  '/uploads',
  express.static(path.join(__dirname, 'uploads'), {
    maxAge: config.nodeEnv === 'production' ? '7d' : 0,
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  })
);

if (config.trustProxy) {
  app.set('trust proxy', 1);
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      if (config.nodeEnv !== 'production') {
        const lanDev =
          /^https?:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/i;
        if (lanDev.test(origin)) {
          callback(null, true);
          return;
        }
      }

      callback(new AppError(403, `CORS origin rejected: ${origin}`));
    },
    credentials: true,
    optionsSuccessStatus: 204,
  })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts. Try again later.' },
});

/** Stricter limits for credential-guessing / reset spray surfaces. */
const authCredentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again later.' },
});

const authRecoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many password reset attempts. Try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again later.' },
});

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res, next) =>
  stripeWebhook(req, res).catch(next)
);

app.use(
  express.json({
    verify(req, res, buf) {
      void res;
      req.rawBody = Buffer.from(buf);
    },
  })
);

app.use('/api/auth', authLimiter);
app.use('/api/v1/auth', authLimiter);
app.use(['/api/auth/login', '/api/v1/auth/login'], authCredentialLimiter);
app.use(['/api/auth/register', '/api/v1/auth/register'], authCredentialLimiter);
app.use(
  ['/api/auth/forgot-password', '/api/v1/auth/forgot-password', '/api/auth/reset-password', '/api/v1/auth/reset-password'],
  authRecoveryLimiter
);
app.use('/api', apiLimiter);
app.use('/api/v1', apiLimiter);

/** SEC-09: redact secrets from logged request paths (tokens, reset links, etc.). */
function redactLoggedPath(rawPath) {
  const path = String(rawPath || '');
  const q = path.indexOf('?');
  if (q < 0) return path;
  const base = path.slice(0, q);
  const params = new URLSearchParams(path.slice(q + 1));
  for (const key of [...params.keys()]) {
    if (/token|secret|password|authorization|sig|signature/i.test(key)) {
      params.set(key, '[redacted]');
    }
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Log every API request + response status to the terminal (dev-friendly). */
app.use((req, res, next) => {
  const started = Date.now();
  const path = req.originalUrl || req.url;
  if (!path.startsWith('/api') && !path.startsWith('/health')) {
    next();
    return;
  }
  // Ignore unrelated browser/extension probes (e.g. socket.io from other tabs).
  if (path.startsWith('/socket.io')) {
    next();
    return;
  }
  res.on('finish', () => {
    const ms = Date.now() - started;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'log';
    const tag = res.statusCode >= 500 ? 'ERR' : res.statusCode >= 400 ? 'WARN' : 'OK';
    console[level](`[${tag}] ${req.method} ${redactLoggedPath(path)} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.get('/health/live', (req, res) => {
  res.json({ status: 'OK' });
});

app.get('/health/ready', async (req, res, next) => {
  try {
    const db = refreshPrismaClientIfNeeded();
    await db.$queryRaw`SELECT 1`;
    await db.$queryRaw`SELECT 1 FROM "CheckoutIntent" LIMIT 1`;
    res.json({ status: 'OK', db: 'connected', checkoutIntent: true });
  } catch (error) {
    if (error?.code === 'PRISMA_CHECKOUT_INTENT_MISSING') {
      return next(error);
    }
    if (error?.code === 'P2021' || /CheckoutIntent/i.test(String(error?.message || ''))) {
      return next(
        new AppError(
          503,
          'Database migration required: run `npx prisma migrate deploy` in backend/',
          'CHECKOUT_INTENT_TABLE_MISSING'
        )
      );
    }
    next(new AppError(503, 'Database unavailable', 'DB_UNAVAILABLE'));
  }
});

app.get('/health', (req, res) => {
  res.redirect(307, '/health/live');
});

/** Same JSON API for web and mobile; v1 is the stable surface for native apps. */
function mountApi(prefix) {
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/products`, productRoutes);
  app.use(`${prefix}/orders`, orderRoutes);
  app.use(`${prefix}/inventory`, inventoryRoutes);
  app.use(`${prefix}/payments`, paymentRoutes);
  app.use(`${prefix}/contact`, contactRoutes);
  app.use(`${prefix}/returns`, returnsRoutes);
  app.use(`${prefix}/wallet`, walletRoutes);
  app.use(`${prefix}/admin`, adminRoutes);
  app.use(`${prefix}/shipping`, shippingRoutes);
  app.use(`${prefix}/public`, publicRoutes);
  app.use(`${prefix}/membership`, membershipRoutes);
  app.use(`${prefix}/checkout`, checkoutRoutes);
  app.use(`${prefix}/wishlist`, wishlistRoutes);
  app.use(`${prefix}/stock-alerts`, stockAlertsRoutes);
  app.use(`${prefix}/system`, systemRoutes);
  app.use(`${prefix}/reviews`, reviewsRoutes);
}

mountApi('/api');
mountApi('/api/v1');

app.get('/api', (req, res) => {
  res.json({
    name: 'Baby Barn API',
    version: '1',
    docs: 'Use /api/v1/* for mobile clients; /api/* is an alias.',
    prefixes: ['/api', '/api/v1'],
    health: '/health/live',
  });
});

app.get('/api/v1', (req, res) => {
  res.json({
    name: 'Baby Barn API',
    version: '1',
    health: '/health/live',
    routes: {
      public: ['/business-settings'],
      membership: ['/registration', '/payments/history', '/savings'],
      auth: [
        '/register',
        '/login',
        '/refresh-token',
        '/forgot-password',
        '/reset-password',
        '/verify-email',
        '/resend-verification',
        '/me',
        '/change-password',
        '/addresses',
        '/addresses/:addressId',
      ],
      products: ['/', '/categories', '/:slugOrPublicId'],
      orders: ['/', '/admin/all', '/:id', '/:id/status'],
      payments: ['/checkout/membership'],
    },
  });
});

app.use((req, res, next) => {
  next(new AppError(404, 'Route not found'));
});

app.use(errorHandler);

const PORT = config.port;

try {
  refreshPrismaClientIfNeeded();
} catch (err) {
  console.error('[startup] Prisma client is missing CheckoutIntent support:', err?.message || err);
  console.error('  Run: cd backend && npx prisma migrate deploy && npx prisma generate');
  console.error('  Then restart this server.');
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  const lan = primaryLanIpv4();
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log(`  Baby Barn API listening on http://localhost:${PORT}`);
  if (lan) {
    console.log(`  Same WiFi:    http://${lan}:${PORT}/api`);
  }
  console.log(`  Health check: http://localhost:${PORT}/health/live`);
  console.log(`  API base:     http://localhost:${PORT}/api`);
  console.log(`  Environment:  ${config.nodeEnv}`);
  console.log('══════════════════════════════════════════════');
  console.log('');

  // SCALE-002: timers still tick on every instance; JobLease ensures only one executes.
  startScheduledJobs();
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
