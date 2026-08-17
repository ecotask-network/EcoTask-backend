import logger from '../utils/logger.js';

export const DEVELOPMENT_JWT_SECRET = 'dev-secret-change-in-production';
export const LEGACY_DEVELOPMENT_JWT_SECRET =
  'dev-secret-change-in-production-at-least-16chars';
export const DOCUMENTATION_JWT_SECRET = 'your_jwt_secret_here';

export const KNOWN_JWT_SECRET_PLACEHOLDERS = new Set([
  DEVELOPMENT_JWT_SECRET,
  LEGACY_DEVELOPMENT_JWT_SECRET,
  DOCUMENTATION_JWT_SECRET,
]);

export function isKnownJwtSecretPlaceholder(secret: string): boolean {
  return KNOWN_JWT_SECRET_PLACEHOLDERS.has(secret.trim());
}

export function resolveJwtSecret(nodeEnv: string, secret?: string): string {
  return secret || (nodeEnv === 'production' ? '' : DEVELOPMENT_JWT_SECRET);
}

export function assertJwtSecretIsSafe(nodeEnv: string, secret: string): void {
  const normalizedSecret = secret.trim();
  const isMissing = normalizedSecret.length === 0;
  const isPlaceholder = isKnownJwtSecretPlaceholder(normalizedSecret);

  if (!isMissing && !isPlaceholder) return;

  if (nodeEnv === 'production') {
    const reason = isMissing
      ? 'JWT_SECRET is required in production.'
      : 'JWT_SECRET matches a known development placeholder and cannot be used in production.';
    throw new Error(`${reason} Set a fresh random secret before starting the server.`);
  }

  logger.warn(
    'JWT_SECRET is using a missing or publicly known development value. ' +
      'Authentication tokens are forgeable with this value; set a fresh random secret before deploying.',
  );
}
