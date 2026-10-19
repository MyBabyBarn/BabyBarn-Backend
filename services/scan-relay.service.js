import { randomBytes, timingSafeEqual } from 'crypto';
import QRCode from 'qrcode';
import { AppError } from '../utils/error-handler.js';

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_RECENT = 20;

/** @type {Map<string, ScanSession>} */
const sessions = new Map();

/**
 * @typedef {{
 *   displayName: string,
 *   roleLabel: string,
 *   deviceLabel: string,
 *   requestedAt: string,
 * }} PendingJoinRequest
 *
 * @typedef {{
 *   id: string,
 *   code: string,
 *   pairingToken: string,
 *   createdBy: string,
 *   createdAt: number,
 *   expiresAt: number,
 *   scannerJoined: boolean,
 *   pendingJoin: PendingJoinRequest | null,
 *   connectedDevice: PendingJoinRequest | null,
 *   recentScans: Array<{ code: string, at: string, actorEmail?: string | null }>,
 *   subscribers: Set<(payload: object) => void>
 * }} ScanSession
 */

function purgeExpired() {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(code);
  }
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function getSession(code) {
  purgeExpired();
  const normalized = String(code || '').trim().toUpperCase();
  const session = sessions.get(normalized);
  if (!session) throw new AppError(404, 'Scan session not found or expired', 'SESSION_NOT_FOUND');
  if (session.expiresAt <= Date.now()) {
    sessions.delete(normalized);
    throw new AppError(404, 'Scan session expired', 'SESSION_EXPIRED');
  }
  return session;
}

function tokensMatch(expected, provided) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(provided || ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function assertPairingToken(code, pairingToken) {
  const session = getSession(code);
  if (!tokensMatch(session.pairingToken, pairingToken)) {
    throw new AppError(401, 'Invalid or expired pairing token', 'PAIRING_TOKEN_INVALID');
  }
  return session;
}

function broadcast(session, payload) {
  for (const send of session.subscribers) {
    try {
      send(payload);
    } catch {
      session.subscribers.delete(send);
    }
  }
}

export function createScanSession(actor) {
  purgeExpired();
  let code = randomCode();
  for (let i = 0; i < 10 && sessions.has(code); i += 1) {
    code = randomCode();
  }
  const now = Date.now();
  const pairingToken = randomBytes(24).toString('base64url');
  /** @type {ScanSession} */
  const session = {
    id: randomBytes(8).toString('hex'),
    code,
    pairingToken,
    createdBy: actor?.id ?? 'unknown',
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    scannerJoined: false,
    pendingJoin: null,
    connectedDevice: null,
    recentScans: [],
    subscribers: new Set(),
  };
  sessions.set(code, session);
  const joinPath = `/warehouse/scanner?code=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.pairingToken)}`;
  return {
    code: session.code,
    pairingToken: session.pairingToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
    joinPath,
  };
}

/**
 * Phone / scanner requests to join. Host must approve before scans are accepted.
 * @param {{ displayName?: string, roleLabel?: string, deviceLabel?: string }} [meta]
 */
export function joinScanSession(code, pairingToken, meta = {}) {
  if (!pairingToken) {
    throw new AppError(401, 'Pairing token is required', 'PAIRING_TOKEN_REQUIRED');
  }
  const session = assertPairingToken(code, pairingToken);
  if (session.scannerJoined) {
    return {
      code: session.code,
      expiresAt: new Date(session.expiresAt).toISOString(),
      scannerJoined: true,
      pendingApproval: false,
    };
  }
  const pending = {
    displayName: String(meta.displayName || 'Phone scanner').slice(0, 80),
    roleLabel: String(meta.roleLabel || 'Team Member').slice(0, 40),
    deviceLabel: String(meta.deviceLabel || 'Mobile device').slice(0, 80),
    requestedAt: new Date().toISOString(),
  };
  session.pendingJoin = pending;
  broadcast(session, { type: 'join_request', pendingJoin: pending, at: pending.requestedAt });
  return {
    code: session.code,
    expiresAt: new Date(session.expiresAt).toISOString(),
    scannerJoined: false,
    pendingApproval: true,
  };
}

export function approveJoinRequest(code, pairingToken) {
  if (!pairingToken) {
    throw new AppError(401, 'Pairing token is required', 'PAIRING_TOKEN_REQUIRED');
  }
  const session = assertPairingToken(code, pairingToken);
  if (!session.pendingJoin && !session.scannerJoined) {
    throw new AppError(400, 'No pending connection request', 'NO_PENDING_JOIN');
  }
  session.connectedDevice = session.pendingJoin || session.connectedDevice;
  session.pendingJoin = null;
  session.scannerJoined = true;
  broadcast(session, {
    type: 'scanner_joined',
    at: new Date().toISOString(),
    connectedDevice: session.connectedDevice,
  });
  return {
    code: session.code,
    expiresAt: new Date(session.expiresAt).toISOString(),
    scannerJoined: true,
    connectedDevice: session.connectedDevice,
  };
}

export function rejectJoinRequest(code, pairingToken) {
  if (!pairingToken) {
    throw new AppError(401, 'Pairing token is required', 'PAIRING_TOKEN_REQUIRED');
  }
  const session = assertPairingToken(code, pairingToken);
  session.pendingJoin = null;
  broadcast(session, { type: 'join_rejected', at: new Date().toISOString() });
  return {
    code: session.code,
    expiresAt: new Date(session.expiresAt).toISOString(),
    scannerJoined: false,
    pendingJoin: null,
  };
}

export function disconnectScanner(code, pairingToken) {
  if (!pairingToken) {
    throw new AppError(401, 'Pairing token is required', 'PAIRING_TOKEN_REQUIRED');
  }
  const session = assertPairingToken(code, pairingToken);
  session.scannerJoined = false;
  session.pendingJoin = null;
  session.connectedDevice = null;
  broadcast(session, { type: 'scanner_disconnected', at: new Date().toISOString() });
  return {
    code: session.code,
    expiresAt: new Date(session.expiresAt).toISOString(),
    scannerJoined: false,
  };
}

export function relayScanToSession(code, scanCode, actor, pairingToken) {
  if (!pairingToken) {
    throw new AppError(401, 'Pairing token is required', 'PAIRING_TOKEN_REQUIRED');
  }
  const session = assertPairingToken(code, pairingToken);
  if (!session.scannerJoined) {
    throw new AppError(
      403,
      'Phone is not approved for this session yet. Wait for host approval.',
      'SCANNER_NOT_APPROVED'
    );
  }
  const normalized = String(scanCode || '').trim();
  if (!normalized) throw new AppError(400, 'Scan code is required');

  const entry = {
    code: normalized,
    at: new Date().toISOString(),
    actorEmail: actor?.email ?? 'phone-scanner',
  };
  session.recentScans.unshift(entry);
  if (session.recentScans.length > MAX_RECENT) {
    session.recentScans.length = MAX_RECENT;
  }

  const payload = { type: 'scan', ...entry };
  broadcast(session, payload);
  return { relayed: true, ...entry };
}

export function getScanSession(code, pairingToken) {
  if (!pairingToken) {
    throw new AppError(401, 'Pairing token is required', 'PAIRING_TOKEN_REQUIRED');
  }
  const session = assertPairingToken(code, pairingToken);
  return {
    code: session.code,
    expiresAt: new Date(session.expiresAt).toISOString(),
    scannerJoined: session.scannerJoined,
    pendingJoin: session.pendingJoin,
    connectedDevice: session.connectedDevice,
    recentScans: session.recentScans,
  };
}

export function subscribeScanSession(code, res, pairingToken) {
  if (!pairingToken) {
    throw new AppError(401, 'Pairing token is required', 'PAIRING_TOKEN_REQUIRED');
  }
  const session = assertPairingToken(code, pairingToken);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  session.subscribers.add(send);
  send({ type: 'connected', code: session.code, recentScans: session.recentScans });

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  reqOnClose(res, () => {
    clearInterval(heartbeat);
    session.subscribers.delete(send);
  });
}

function reqOnClose(res, fn) {
  res.on('close', fn);
  res.on('finish', fn);
}

export async function renderSessionJoinQr(code, joinUrl) {
  const url = joinUrl || `/warehouse/scanner?code=${encodeURIComponent(code)}`;
  return QRCode.toBuffer(url, { type: 'png', margin: 1, width: 240 });
}

export const scanRelayService = {
  createScanSession,
  joinScanSession,
  approveJoinRequest,
  rejectJoinRequest,
  disconnectScanner,
  relayScanToSession,
  getScanSession,
  subscribeScanSession,
  renderSessionJoinQr,
  assertPairingToken,
};
