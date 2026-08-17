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
