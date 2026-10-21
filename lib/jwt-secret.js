const DEFAULT_JWT_SECRET = 'your-secret-key-change-in-production';
const DEFAULT_REFRESH_SECRET = 'your-refresh-secret-change-in-production';

export function isLocalJwtEnvironment(nodeEnv) {
  const env = String(nodeEnv || 'development').toLowerCase();
  return env === 'development' || env === 'test';
}

/**
 * SEC-02: deployed environments must not boot with a missing, short, or well-known JWT secret.
 * Local development and tests may keep the placeholder so the app can start.
 */
export function assertJwtSecret(name, value, nodeEnv) {
  if (isLocalJwtEnvironment(nodeEnv)) return;
  const secret = typeof value === 'string' ? value : '';
  const knownDefault = secret === DEFAULT_JWT_SECRET || secret === DEFAULT_REFRESH_SECRET;
  if (!secret || secret.length < 32 || knownDefault) {
    throw new Error(
      `${name} must be a unique secret of at least 32 characters. The development placeholder is not accepted outside local development.`
    );
  }
}
