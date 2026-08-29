import jwt from 'jsonwebtoken';
import config from '../../src/config/default';
import { denylistCircuitBreaker } from '../../src/middleware/auth';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the module under test is imported
// ---------------------------------------------------------------------------

jest.mock('../../src/config/default', () => ({
  port: 3000,
  nodeEnv: 'test',
  corsOrigin: '*',
  database: { url: 'postgresql://test:test@localhost:5432/ecotask_test' },
  redis: { url: 'redis://localhost:6379' },
  jwt: {
    secret: 'test-secret-for-auth-middleware',
    expiresIn: '1h',
    issuer: 'test-issuer',
    audience: 'test-audience',
  },
  auth: {
    challengeTtlMs: 300000,
    challengeIssueWindowMs: 900000,
    challengeIssueMax: 10,
    denylistCircuitBreaker: {
      failureThreshold: 3,
      cooldownMs: 50,
    },
  },
  rateLimit: {
    proofWindowMs: 3600000,
    proofMax: 20,
    claimWindowMs: 3600000,
    claimMax: 50,
  },
  expirySweepIntervalMs: 900000,
  stellar: { network: 'testnet', oracleSecretKey: '', rewardEngineContractId: '' },
  ipfs: { web3StorageToken: '' },
  notification: {
    webhookTimeoutMs: 5000,
    emailFrom: 'test@test.com',
    outboxMaxAttempts: 3,
    outboxBatchSize: 20,
    outboxSweepIntervalMs: 30000,
  },
  queueRetention: {
    proofVerification: { completedCount: 1000, failedAgeSeconds: 604800 },
    rewardPayout: { completedCount: 1000, failedAgeSeconds: 604800 },
    notificationDispatch: { completedCount: 1000, failedAgeSeconds: 604800 },
  },
  validator: { assignmentCount: 3, quorumRequired: 2 },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/workers/verificationWorker', () => ({
  enqueueVerification: jest.fn(),
}));

interface FakeRedisStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(key: string): void;
  throwOnGet: Error | null;
}

const fakeRedisStore = new Map<string, string>();
let throwOnGet: Error | null = null;

jest.mock('../../src/services/rateLimitService', () => ({
  rateLimiter: {
    getClient: () => ({
      get: jest.fn(async (key: string) => {
        if (throwOnGet) throw throwOnGet;
        return fakeRedisStore.get(key) ?? null;
      }),
      set: jest.fn(async (key: string, value: string, mode?: string, ttl?: number) => {
        fakeRedisStore.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => {
        fakeRedisStore.delete(key);
        return 1;
      }),
    }),
    check: jest
      .fn()
      .mockResolvedValue({ allowed: true, remaining: 9, retryAfterSeconds: 900 }),
  },
}));

// Mock rate limit middleware so it never blocks
const noopLimiter = () => (_req: unknown, _res: unknown, next: () => void) => next();
jest.mock('../../src/middleware/rateLimit', () => ({
  apiLimiter: noopLimiter(),
  authLimiter: noopLimiter(),
  proofLimiter: noopLimiter(),
  proofSubmissionLimiter: noopLimiter(),
  claimLimiter: noopLimiter(),
  challengeIssueLimiter: noopLimiter(),
  perUserLimiter: () => noopLimiter(),
}));

jest.mock('../../src/workers/notificationWorker', () => ({}));
jest.mock('../../src/workers/rewardWorker', () => ({}));
jest.mock('../../src/workers/expiryWorker', () => ({}));

// ---------------------------------------------------------------------------
// Import app and helpers AFTER mocks are in place
// ---------------------------------------------------------------------------

import request from 'supertest';
import app from '../../src/app';

const SECRET = config.jwt.secret;

function makeToken(jti?: string) {
  return jwt.sign({ userId: 'u1', wallet: 'GWALLET123' }, SECRET, {
    expiresIn: '1h',
    algorithm: 'HS256',
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    jwtid: jti ?? crypto.randomUUID(),
  });
}

import crypto from 'crypto';

describe('JWT denylist — fail-closed behaviour (issue #68)', () => {
  beforeEach(() => {
    fakeRedisStore.clear();
    throwOnGet = null;
    denylistCircuitBreaker.reset();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Revoked tokens are always rejected when Redis is healthy
  // -------------------------------------------------------------------------

  it('rejects a revoked token when Redis is healthy', async () => {
    const jti = 'revoked-jti-1';
    const token = makeToken(jti);

    // Add to denylist
    fakeRedisStore.set(`jwt_denylist:${jti}`, '1');

    const res = await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('token revoked');
  });

  it('allows a non-revoked token when Redis is healthy', async () => {
    const token = makeToken('not-revoked-jti');

    const res = await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // 2. Redis outage → fail-closed (503), NOT fail-open (200)
  // -------------------------------------------------------------------------

  it('returns 503 (fail-closed) when Redis is down — NOT 200', async () => {
    const token = makeToken('some-jti');

    // Simulate Redis failure
    throwOnGet = new Error('ECONNREFUSED');

    const res = await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    // Before the fix, non-strict middleware returned 200 (fail-open).
    // After the fix, it must return 503 (fail-closed).
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('auth service unavailable');
  });

  it('returns 503 even for a non-revoked token during Redis outage', async () => {
    const token = makeToken('innocent-jti');

    throwOnGet = new Error('ETIMEDOUT');

    const res = await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
  });

  // -------------------------------------------------------------------------
  // 3. Tokens WITHOUT a jti bypass the denylist check entirely
  // -------------------------------------------------------------------------

  it('allows a token without jti even when Redis is down', async () => {
    // Sign without jwtid
    const token = jwt.sign({ userId: 'u1', wallet: 'GWALLET123' }, SECRET, {
      expiresIn: '1h',
      algorithm: 'HS256',
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      // no jwtid
    });

    throwOnGet = new Error('ECONNREFUSED');

    const res = await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${token}`);

    // No jti → denylist check is skipped entirely → request proceeds
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // 4. Circuit breaker: opens after threshold failures, fast-fails
  // -------------------------------------------------------------------------

  describe('circuit breaker', () => {
    it('opens after 3 consecutive Redis failures and fast-fails', async () => {
      const token = makeToken('cb-test-jti');
      throwOnGet = new Error('ECONNREFUSED');

      // Request 1 — Redis fails, circuit still CLOSED (failure #1)
      await request(app).post('/auth/verify').set('Authorization', `Bearer ${token}`);
      expect(denylistCircuitBreaker.getState()).toBe('CLOSED');

      // Request 2 — failure #2
      await request(app).post('/auth/verify').set('Authorization', `Bearer ${token}`);
      expect(denylistCircuitBreaker.getState()).toBe('CLOSED');

      // Request 3 — failure #3 → threshold reached, circuit OPENS
      await request(app).post('/auth/verify').set('Authorization', `Bearer ${token}`);
      expect(denylistCircuitBreaker.getState()).toBe('OPEN');

      // Request 4 — circuit is OPEN → fast-fail (no Redis call attempted)
      const res = await request(app)
        .post('/auth/verify')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('auth service unavailable');
    });

    it('recovers to HALF_OPEN after cooldown and closes on success', async () => {
      const token = makeToken('recover-jti');

      // Trip the circuit
      throwOnGet = new Error('ECONNREFUSED');
      for (let i = 0; i < 3; i++) {
        await request(app).post('/auth/verify').set('Authorization', `Bearer ${token}`);
      }
      expect(denylistCircuitBreaker.getState()).toBe('OPEN');

      // Wait for cooldown (50ms in test config)
      await new Promise((r) => setTimeout(r, 80));

      // Fix Redis
      throwOnGet = null;

      // Next request — circuit probes Redis (HALF_OPEN), succeeds → CLOSED
      const res = await request(app)
        .post('/auth/verify')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(denylistCircuitBreaker.getState()).toBe('CLOSED');
    });

    it('re-opens on probe failure during HALF_OPEN', async () => {
      const token = makeToken('halfopen-fail-jti');

      // Trip the circuit
      throwOnGet = new Error('ECONNREFUSED');
      for (let i = 0; i < 3; i++) {
        await request(app).post('/auth/verify').set('Authorization', `Bearer ${token}`);
      }
      expect(denylistCircuitBreaker.getState()).toBe('OPEN');

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 80));

      // Redis still broken — probe fails → re-opens
      await request(app).post('/auth/verify').set('Authorization', `Bearer ${token}`);
      expect(denylistCircuitBreaker.getState()).toBe('OPEN');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Revoked token during Redis outage: still 503 (not silently accepted)
  // -------------------------------------------------------------------------

  it('does NOT silently accept a known-revoked token during Redis outage', async () => {
    const jti = 'known-revoked-jti';
    const token = makeToken(jti);

    // Put the token in the denylist while Redis is up
    fakeRedisStore.set(`jwt_denylist:${jti}`, '1');

    // Verify it's rejected while Redis is healthy
    const before = await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(401);

    // Now Redis goes down
    throwOnGet = new Error('ECONNREFUSED');

    // With fail-closed, the request is rejected with 503 (not accepted with 200)
    const after = await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(503);
    expect(after.body.error).toBe('auth service unavailable');
    // The critical invariant: it was NOT 200 (fail-open)
  });

  // -------------------------------------------------------------------------
  // 6. Logout still works normally with healthy Redis
  // -------------------------------------------------------------------------

  it('logout adds jti to denylist and subsequent requests are rejected', async () => {
    const jti = 'logout-test-jti';
    const token = makeToken(jti);

    // Verify token works
    let res = await request(app)
      .post('/auth/verify')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    // Logout
    res = await request(app).post('/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    // Token should now be revoked
    res = await request(app).post('/auth/verify').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('token revoked');
  });
});
