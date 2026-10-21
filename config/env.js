import dotenv from 'dotenv';
import { parseDurationToMs } from '../lib/duration.js';

dotenv.config();

const port = parseInt(process.env.PORT || '5000', 10);
const nodeEnv = process.env.NODE_ENV || 'development';

function splitCsv(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toUnique(items) {
  return [...new Set(items)];
}

if (nodeEnv === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required in production');
}

const jwtExpiryTime = process.env.JWT_EXPIRY || '15m';
const jwtRefreshExpiryTime = process.env.JWT_REFRESH_EXPIRY || '30d';

export const config = {
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost/ecommerce',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    /** Access JWT lifetime (jsonwebtoken expiresIn string). Default 15m (SEC-001 P1). */
    expiryTime: jwtExpiryTime,
    refreshSecret: process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'your-refresh-secret-change-in-production',
    refreshExpiryTime: jwtRefreshExpiryTime,
    /** Opaque refresh token TTL in ms (derived from JWT_REFRESH_EXPIRY). */
    refreshExpiryMs: parseDurationToMs(jwtRefreshExpiryTime, 30 * 24 * 60 * 60 * 1000),
  },
  port,
  nodeEnv,
  /**
   * CORS:
   * - CORS_ORIGIN can hold a full comma-separated allowlist.
   * - FRONTEND_USER_URLS / FRONTEND_ADMIN_URLS support split config by app.
   * - Dev defaults ensure local admin + customer apps work out of the box.
   */
  corsOrigins: toUnique([
    ...splitCsv(process.env.CORS_ORIGIN),
    ...splitCsv(process.env.FRONTEND_USER_URLS),
    ...splitCsv(process.env.FRONTEND_ADMIN_URLS),
    ...(nodeEnv === 'production'
      ? []
      : ['http://localhost:3000', 'http://localhost:3001']),
  ]),
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    connectMembership: process.env.STRIPE_CONNECT_ACCOUNT_MEMBERSHIP || '',
    connectStore: process.env.STRIPE_CONNECT_ACCOUNT_STORE || '',
  },
  mail: {
    from: process.env.MAIL_FROM || 'Baby Barn <no-reply@babyburn.local>',
    /** `smtp` | `sendgrid` | `auto` (default: sendgrid if key set, else smtp; dev prefers smtp when both set). */
    provider: (process.env.EMAIL_PROVIDER || 'auto').trim().toLowerCase(),
    /** SendGrid REST API — verified sender must match MAIL_FROM domain. */
    sendgridApiKey: (process.env.SENDGRID_API_KEY || '').trim(),
    /**
     * SendGrid click tracking rewrites links to urlNNNN.yourdomain.com/ls/click?...
     * Off by default so CTAs keep real app URLs (verify-email, orders, etc.).
     */
    sendgridClickTracking: process.env.SENDGRID_CLICK_TRACKING === 'true',
    /** Optional override for SMTP From (defaults to SMTP_USER display name). */
    smtpFrom: (process.env.MAIL_SMTP_FROM || '').trim(),
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    secure: process.env.SMTP_SECURE === 'true',
  },
  frontend: {
    customerUrl: (process.env.CUSTOMER_FRONTEND_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, ''),
    adminUrl: (process.env.ADMIN_FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, ''),
  },
  storeUrl: (
    process.env.STORE_PUBLIC_URL ||
    process.env.CUSTOMER_FRONTEND_URL ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, ''),
  trustProxy: process.env.TRUST_PROXY === 'true',
  /** Optional base URL for absolute image URLs returned to the client (no trailing slash). */
  publicBaseUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  /** Inbound contact form notifications (falls back to SMTP user if unset). */
  contactAdminEmail: (process.env.CONTACT_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim(),
  /** Branding overrides for emails/PDFs (defaults align with packages/brand/brand.tokens.json). */
  brand: {
    supportEmail: (process.env.BRAND_SUPPORT_EMAIL || 'hello@babybarn.co').trim(),
    logoPath: (process.env.BRAND_LOGO_PATH || '/brand/logo-mark.svg').trim(),
  },
  /**
   * When false, this process does not run in-process schedulers (SCALE-002).
   * Use on pure API replicas if a dedicated worker owns BACKGROUND_JOBS_ENABLED=true.
   * Default true so single-instance deploys keep prior behavior.
   */
  backgroundJobsEnabled: process.env.BACKGROUND_JOBS_ENABLED !== 'false',
  /** Unpaid checkout orders older than this are expired and resources released (minutes). */
  pendingOrderTtlMinutes: parseInt(process.env.PENDING_ORDER_TTL_MINUTES || '60', 10),
  /** When true, approving a STANDARD return restocks one unit to the original SKU. */
  /** Blind auto-restock on approve is off; admins restock via pick UI (plan 41). */
  standardReturnRestock: process.env.STANDARD_RETURN_RESTOCK === 'true',
  salesTaxRate: Number(process.env.SALES_TAX_RATE ?? 0.06),
  /** Merchandise subtotal at or above this amount waives shipping at checkout (USD). */
  freeShippingThresholdUsd: Number(process.env.FREE_SHIPPING_THRESHOLD_USD ?? 75),
  /** Days before ACCESS expiry to send the pre-expiry reminder email (comma-separated for multiple, e.g. "14,0"). */
  accessRenewalReminderDays: (process.env.ACCESS_RENEWAL_REMINDER_DAYS || '14,0')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n) && n >= 0),
  /**
   * Address verification. Provider is auto-selected from configured credentials.
   * - USPS: set USPS_CLIENT_ID + USPS_CLIENT_SECRET (USPS APIs v3, OAuth).
   * - UPS:  set UPS_CLIENT_ID + UPS_CLIENT_SECRET (UPS OAuth + Address Validation).
   * When no credentials are set the service no-ops (addresses save unchanged).
   * Set ADDRESS_VERIFY_STRICT=true to reject undeliverable addresses instead of warning.
   */
  addressVerification: {
    provider: (process.env.ADDRESS_VERIFY_PROVIDER || 'auto').trim().toLowerCase(),
    strict: process.env.ADDRESS_VERIFY_STRICT === 'true',
    usps: {
      clientId: (process.env.USPS_CLIENT_ID || '').trim(),
      clientSecret: (process.env.USPS_CLIENT_SECRET || '').trim(),
      baseUrl: (process.env.USPS_API_BASE_URL || 'https://apis.usps.com').replace(/\/$/, ''),
    },
    ups: {
      clientId: (process.env.UPS_CLIENT_ID || '').trim(),
      clientSecret: (process.env.UPS_CLIENT_SECRET || '').trim(),
      baseUrl: (process.env.UPS_API_BASE_URL || 'https://onlinetools.ups.com').replace(/\/$/, ''),
    },
  },
};
