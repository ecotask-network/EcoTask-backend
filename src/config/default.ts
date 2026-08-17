import { resolveJwtSecret } from './jwtSecret.js';

const nodeEnv = process.env.NODE_ENV || 'development';

export default {
  port: parseInt(process.env.PORT || '3000'),
  nodeEnv,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  database: {
    url:
      process.env.DATABASE_URL || 'postgresql://ecotask:ecotask@localhost:5432/ecotask',
  },
  redis: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
  queueRetention: {
    proofVerification: {
      completedCount: parseInt(
        process.env.PROOF_VERIFICATION_QUEUE_COMPLETED_RETENTION_COUNT || '1000',
        10,
      ),
      failedAgeSeconds: parseInt(
        process.env.PROOF_VERIFICATION_QUEUE_FAILED_RETENTION_SECONDS || '604800',
        10,
      ),
    },
    rewardPayout: {
      completedCount: parseInt(
        process.env.REWARD_PAYOUT_QUEUE_COMPLETED_RETENTION_COUNT || '1000',
        10,
      ),
      failedAgeSeconds: parseInt(
        process.env.REWARD_PAYOUT_QUEUE_FAILED_RETENTION_SECONDS || '604800',
        10,
      ),
    },
    notificationDispatch: {
      completedCount: parseInt(
        process.env.NOTIFICATION_DISPATCH_QUEUE_COMPLETED_RETENTION_COUNT || '1000',
        10,
      ),
      failedAgeSeconds: parseInt(
        process.env.NOTIFICATION_DISPATCH_QUEUE_FAILED_RETENTION_SECONDS || '604800',
        10,
      ),
    },
  },
  expirySweepIntervalMs: parseInt(process.env.EXPIRY_SWEEP_INTERVAL_MS || '900000', 10),
  stellar: {
    network: process.env.STELLAR_NETWORK || 'testnet',
    oracleSecretKey: process.env.STELLAR_ORACLE_SECRET_KEY || '',
    rewardEngineContractId: process.env.REWARD_ENGINE_CONTRACT_ID || '',
  },
  ipfs: { web3StorageToken: process.env.WEB3_STORAGE_TOKEN || '' },
  notification: {
    webhookTimeoutMs: parseInt(process.env.NOTIFICATION_WEBHOOK_TIMEOUT_MS || '5000', 10),
    emailFrom:
      process.env.NOTIFICATION_EMAIL_FROM || 'EcoTask <no-reply@ecotask.network>',
    outboxMaxAttempts: parseInt(process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS || '3', 10),
    outboxBatchSize: parseInt(process.env.NOTIFICATION_OUTBOX_BATCH_SIZE || '20', 10),
    outboxSweepIntervalMs: parseInt(
      process.env.NOTIFICATION_OUTBOX_SWEEP_INTERVAL_MS || '30000',
      10,
    ),
  },
  rateLimit: {
    proofWindowMs: parseInt(
      process.env.PROOF_RATE_LIMIT_WINDOW_MS || String(60 * 60 * 1000),
      10,
    ),
    proofMax: parseInt(process.env.PROOF_RATE_LIMIT_MAX || '20', 10),
    claimWindowMs: parseInt(
      process.env.CLAIM_RATE_LIMIT_WINDOW_MS || String(60 * 60 * 1000),
      10,
    ),
    claimMax: parseInt(process.env.CLAIM_RATE_LIMIT_MAX || '50', 10),
  },
  validator: {
    assignmentCount: parseInt(process.env.VALIDATOR_ASSIGNMENT_COUNT || '3', 10),
    quorumRequired: parseInt(process.env.VALIDATOR_QUORUM_REQUIRED || '2', 10),
  },
  jwt: {
    secret: resolveJwtSecret(nodeEnv, process.env.JWT_SECRET),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    issuer: process.env.JWT_ISSUER || 'ecotask-backend',
    audience: process.env.JWT_AUDIENCE || 'ecotask-users',
  },
};
