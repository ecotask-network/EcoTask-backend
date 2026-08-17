import { z } from 'zod';
import logger from '../utils/logger.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  EXPIRY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(900000),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  STELLAR_NETWORK: z.enum(['testnet', 'public']).default('testnet'),
  STELLAR_ORACLE_SECRET_KEY: z.string().optional(),
  REWARD_ENGINE_CONTRACT_ID: z.string().optional(),
  WEB3_STORAGE_TOKEN: z.string().optional(),
  NOTIFICATION_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  NOTIFICATION_EMAIL_FROM: z.string().default('EcoTask <no-reply@ecotask.network>'),
  NOTIFICATION_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  NOTIFICATION_OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  NOTIFICATION_OUTBOX_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30000),
  PROOF_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3600000),
  PROOF_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  CLAIM_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(3600000),
  CLAIM_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(50),
  VALIDATOR_ASSIGNMENT_COUNT: z.coerce.number().int().positive().default(3),
  VALIDATOR_QUORUM_REQUIRED: z.coerce.number().int().positive().default(2),
});

export type EnvConfig = z.infer<typeof envSchema>;

let validatedEnv: EnvConfig | null = null;

export function validateEnv(): EnvConfig {
  if (validatedEnv) return validatedEnv;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const messages = Object.entries(errors)
      .map(([field, msgs]) => `  ${field}: ${msgs?.join(', ')}`)
      .join('\n');

    logger.error(`Environment validation failed:\n${messages}`);

    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }

    logger.warn('Using fallback defaults for missing env vars (development mode)');
    validatedEnv = envSchema.parse({
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL || 'postgresql://ecotask:ecotask@localhost:5432/ecotask',
      JWT_SECRET:
        process.env.JWT_SECRET || 'dev-secret-change-in-production-at-least-16chars',
    });
    return validatedEnv;
  }

  validatedEnv = result.data;
  logger.info('Environment configuration validated successfully');
  return validatedEnv;
}
