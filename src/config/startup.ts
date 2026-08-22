import config from './default.js';
import { assertJwtSecretIsSafe } from './jwtSecret.js';
import { validateEnv } from './validate.js';
import logger from '../utils/logger.js';

export function validateStartupConfiguration(): void {
  const env = validateEnv();
  assertJwtSecretIsSafe(env.NODE_ENV, config.jwt.secret);
}

if (process.env.NODE_ENV !== 'test') {
  try {
    validateStartupConfiguration();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown configuration error';
    logger.error(`Startup configuration validation failed: ${message}`);
    process.exit(1);
  }
}
