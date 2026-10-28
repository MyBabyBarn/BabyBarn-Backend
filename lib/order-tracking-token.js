import crypto from 'crypto';
import { config } from '../config/env.js';
import { AppError } from '../utils/error-handler.js';

// SEC-09: shorter TTL; prefer dedicated tracking secret over the JWT secret.
const TRACKING_TTL_MS = Number(process.env.ORDER_TRACKING_TTL_DAYS || 14) * 24 * 60 * 60 * 1000;

function trackingHmacSecret() {
  const dedicated = String(process.env.ORDER_TRACKING_SECRET || '').trim();
  if (dedicated.length >= 32) return dedicated;
  return config.jwt.secret;
}

function signPayload(orderNumber, email, exp) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const payload = `${orderNumber}|${normalizedEmail}|${exp}`;
  const sig = crypto.createHmac('sha256', trackingHmacSecret()).update(payload).digest('base64url');
  return `${payload}|${sig}`;
}

export function createOrderTrackingToken({ orderNumber, email }) {
  if (!orderNumber || !email) {
    throw new AppError(400, 'orderNumber and email are required for tracking token');
  }
  const exp = Date.now() + TRACKING_TTL_MS;
  return Buffer.from(signPayload(orderNumber, email, exp)).toString('base64url');
}

export function verifyOrderTrackingToken(token) {
  if (!token || typeof token !== 'string') {
    throw new AppError(400, 'Tracking token is required', 'TRACKING_TOKEN_REQUIRED');
  }
  let raw;
  try {
    raw = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    throw new AppError(400, 'Invalid tracking token', 'TRACKING_TOKEN_INVALID');
  }
  const parts = raw.split('|');
  if (parts.length !== 4) {
    throw new AppError(400, 'Invalid tracking token', 'TRACKING_TOKEN_INVALID');
  }
  const [orderNumber, email, expStr, sig] = parts;
  const expected = signPayload(orderNumber, email, Number(expStr));
  const expectedSig = expected.split('|')[3];
  if (!sig || sig.length !== expectedSig.length) {
    throw new AppError(400, 'Invalid tracking token', 'TRACKING_TOKEN_INVALID');
  }
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    throw new AppError(400, 'Invalid tracking token', 'TRACKING_TOKEN_INVALID');
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) {
    throw new AppError(410, 'Tracking link has expired', 'TRACKING_TOKEN_EXPIRED');
  }
  return { orderNumber, email };
}

export function buildOrderTrackingUrl({ orderNumber, email }) {
  const token = createOrderTrackingToken({ orderNumber, email });
  return `${config.frontend.customerUrl}/orders/track?token=${encodeURIComponent(token)}`;
}

export function buildGuestReturnUrl({ orderNumber, email }) {
  const token = createOrderTrackingToken({ orderNumber, email });
  return `${config.frontend.customerUrl}/returns/guest?token=${encodeURIComponent(token)}`;
}
