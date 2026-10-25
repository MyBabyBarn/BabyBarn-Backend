import { AppError } from '../utils/error-handler.js';

/**
 * SEC-16: in-process per-account (+ IP) lockout after repeated failed logins.
 * Prefer Redis in multi-instance deploys; this still closes the single-process gap.
 */
const MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES || 5);
const LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 15 * 60 * 1000);
const WINDOW_MS = Number(process.env.LOGIN_FAILURE_WINDOW_MS || 15 * 60 * 1000);

/** @type {Map<string, { count: number, firstAt: number, lockedUntil: number }>} */
const failures = new Map();

function keyFor(email, ip) {
  const e = String(email || '').trim().toLowerCase();
  const i = String(ip || 'unknown').trim();
  return `${e}|${i}`;
}

export function assertLoginAllowed(email, ip) {
  const key = keyFor(email, ip);
  const row = failures.get(key);
  if (!row) return;
  if (row.lockedUntil && row.lockedUntil > Date.now()) {
    const mins = Math.max(1, Math.ceil((row.lockedUntil - Date.now()) / 60000));
    throw new AppError(
      429,
      `Too many failed sign-in attempts. Try again in about ${mins} minute(s).`,
      'LOGIN_LOCKED'
    );
  }
  if (row.firstAt && Date.now() - row.firstAt > WINDOW_MS) {
    failures.delete(key);
  }
}

export function recordLoginFailure(email, ip) {
  const key = keyFor(email, ip);
  const now = Date.now();
  const prev = failures.get(key);
  if (!prev || now - prev.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return { count: 1, locked: false };
  }
  const count = prev.count + 1;
  const lockedUntil = count >= MAX_FAILURES ? now + LOCK_MS : 0;
  failures.set(key, { count, firstAt: prev.firstAt, lockedUntil });
  return { count, locked: lockedUntil > 0 };
}

export function clearLoginFailures(email, ip) {
  failures.delete(keyFor(email, ip));
}

/** Test helper */
export function _resetLoginLockoutForTests() {
  failures.clear();
}
