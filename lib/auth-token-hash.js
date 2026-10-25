import crypto from 'crypto';

/** SEC-07: store only SHA-256 hashes of one-time auth tokens. */
export function hashAuthToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || ''), 'utf8').digest('hex');
}
