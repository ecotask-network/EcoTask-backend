import request from 'supertest';
import app from '../../src/app';
import { generateChallenge } from '../../src/services/stellarService';
import { Keypair } from '@stellar/stellar-sdk';

import jwt from 'jsonwebtoken';
import config from '../../src/config/default';

jest.mock('../../src/workers/verificationWorker', () => ({
  enqueueVerification: jest.fn(),
}));

// `authLimiter` (src/middleware/rateLimit.ts) is a global, in-memory,
// per-process express-rate-limit instance mounted on the whole `/auth`
// router in app.ts. It shares one counter across every test in this file
// (and is itself the subject of a separate, already-tracked issue about
// being in-memory rather than Redis-backed), so it's bypassed here to keep
// these tests focused on the challenge/login flow instead of on how many
// requests earlier tests happened to make.
jest.mock('../../src/middleware/rateLimit', () => {
  const actual = jest.requireActual('../../src/middleware/rateLimit');
  return {
    ...actual,
    authLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const mockFindOrCreateUser = jest.fn();
jest.mock('../../src/models/user', () => ({
  findOrCreateUser: (...args: unknown[]) => mockFindOrCreateUser(...args),
}));

interface StoredEntry {
  value: string;
  expiresAt: number;
}

/**
 * Minimal in-memory stand-in for the ioredis client, shared by every module
 * that resolves `rateLimiter.getClient()` in this test file (including
 * modules re-required via `jest.isolateModules`). This is what lets the
 * "shared store" tests prove state lives in Redis, not in per-module memory.
 */
class FakeRedis {
  store = new Map<string, StoredEntry>();

  set = jest.fn(async (key: string, value: string, mode: 'EX' | 'PX', ttl: number) => {
    const ttlMs = mode === 'EX' ? ttl * 1000 : ttl;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return 'OK';
  });

  get = jest.fn(async (key: string) => {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  });

  // No `await` between the read and the delete, so concurrent callers can
  // never both observe a value, mirroring Redis's atomic GETDEL.
  getdel = jest.fn(async (key: string) => {
    const entry = this.store.get(key);
    if (!entry) return null;
    this.store.delete(key);
    if (entry.expiresAt < Date.now()) return null;
    return entry.value;
  });

  del = jest.fn(async (key: string) => (this.store.delete(key) ? 1 : 0));
}

const mockRedisClient = new FakeRedis();

jest.mock('../../src/services/rateLimitService', () => ({
  rateLimiter: {
    getClient: () => mockRedisClient,
    check: jest
      .fn()
      .mockResolvedValue({ allowed: true, remaining: 9, retryAfterSeconds: 900 }),
  },
}));

const MOCK_WALLET = 'GBMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCK00';

function signChallenge(kp: Keypair, challenge: string) {
  return kp.sign(Buffer.from(`EcoTask login: ${challenge}`)).toString('hex');
}

describe('Auth Routes', () => {
  beforeEach(() => {
    mockRedisClient.store.clear();
    mockFindOrCreateUser.mockReset();
    mockFindOrCreateUser.mockResolvedValue({ id: 'user-1', wallet: MOCK_WALLET });
  });

  it('GET /auth/challenge returns a challenge string for valid wallet', async () => {
    const res = await request(app).get('/auth/challenge').query({ wallet: MOCK_WALLET });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(typeof res.body.challenge).toBe('string');
  });

  it('GET /auth/challenge returns 400 for invalid wallet', async () => {
    const res = await request(app).get('/auth/challenge').query({ wallet: 'short' });
    expect(res.status).toBe(400);
  });

  it('GET /auth/challenge stores the challenge in Redis under the configured TTL', async () => {
    const res = await request(app).get('/auth/challenge').query({ wallet: MOCK_WALLET });

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      `login_challenge:${MOCK_WALLET}`,
      res.body.challenge,
      'PX',
      config.auth.challengeTtlMs,
    );
  });

  it('POST /auth/login fails with invalid signature', async () => {
    const challenge = generateChallenge();
    const res = await request(app).post('/auth/login').send({
      wallet: MOCK_WALLET,
      signature: 'abcdef1234567890abcdef1234567890',
      challenge,
    });
    expect(res.status).toBe(401);
  });

  it('POST /auth/login returns 400 for missing fields', async () => {
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(400);
  });

  describe('Redis-backed challenge store', () => {
    it('completes a full challenge -> login round trip against the Redis-backed store', async () => {
      const kp = Keypair.random();
      const wallet = kp.publicKey();

      const challengeRes = await request(app).get('/auth/challenge').query({ wallet });
      expect(challengeRes.status).toBe(200);
      const { challenge } = challengeRes.body;

      const res = await request(app)
        .post('/auth/login')
        .send({ wallet, signature: signChallenge(kp, challenge), challenge });

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
    });

    it('rejects a login once the challenge has already been consumed (single use)', async () => {
      const kp = Keypair.random();
      const wallet = kp.publicKey();

      const { body } = await request(app).get('/auth/challenge').query({ wallet });
      const signature = signChallenge(kp, body.challenge);

      const first = await request(app)
        .post('/auth/login')
        .send({ wallet, signature, challenge: body.challenge });
      expect(first.status).toBe(200);

      const replay = await request(app)
        .post('/auth/login')
        .send({ wallet, signature, challenge: body.challenge });
      expect(replay.status).toBe(401);
    });

    it('rejects a login once the challenge TTL has elapsed, with no cleanup timer involved', async () => {
      const kp = Keypair.random();
      const wallet = kp.publicKey();

      const { body } = await request(app).get('/auth/challenge').query({ wallet });
      const key = `login_challenge:${wallet}`;
      const entry = mockRedisClient.store.get(key);
      expect(entry).toBeDefined();

      // Simulate Redis-side TTL expiry directly (no app-level interval exists
      // to delete this; the store itself must reject a read past expiresAt).
      mockRedisClient.store.set(key, { ...entry!, expiresAt: Date.now() - 1 });

      const res = await request(app)
        .post('/auth/login')
        .send({
          wallet,
          signature: signChallenge(kp, body.challenge),
          challenge: body.challenge,
        });

      expect(res.status).toBe(401);
    });

    it('resolves a concurrent race on the same challenge: exactly one login succeeds', async () => {
      const kp = Keypair.random();
      const wallet = kp.publicKey();

      const { body } = await request(app).get('/auth/challenge').query({ wallet });
      const signature = signChallenge(kp, body.challenge);

      const [first, second] = await Promise.all([
        request(app)
          .post('/auth/login')
          .send({ wallet, signature, challenge: body.challenge }),
        request(app)
          .post('/auth/login')
          .send({ wallet, signature, challenge: body.challenge }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 401]);
    });

    it('shares challenge state across independently-loaded controller instances via Redis, not an in-process map', async () => {
      let controllerA: typeof import('../../src/controllers/authController');
      let controllerB: typeof import('../../src/controllers/authController');

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        controllerA = require('../../src/controllers/authController');
      });
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        controllerB = require('../../src/controllers/authController');
      });

      const kp = Keypair.random();
      const wallet = kp.publicKey();

      const getRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      // "Instance A" issues the challenge.
      await controllerA!.getChallenge({ query: { wallet } } as never, getRes as never);
      expect(getRes.status).not.toHaveBeenCalled();
      const { challenge } = getRes.json.mock.calls[0][0];

      const loginRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      // "Instance B" — a separate module instance with its own module-level
      // state — completes the login using only what it can read from Redis.
      await controllerB!.login(
        {
          body: { wallet, signature: signChallenge(kp, challenge), challenge },
        } as never,
        loginRes as never,
      );

      expect(loginRes.status).not.toHaveBeenCalledWith(401);
      expect(loginRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ token: expect.any(String) }),
      );
    });
  });

  describe('Security Enhancements', () => {
    it('rejects token with missing issuer or audience', async () => {
      const token = jwt.sign({ userId: '1', wallet: MOCK_WALLET }, config.jwt.secret, {
        expiresIn: '1h',
        algorithm: 'HS256',
      });
      const res = await request(app)
        .post('/auth/verify')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('rejects token signed with wrong algorithm (none)', async () => {
      const token = jwt.sign(
        {
          userId: '1',
          wallet: MOCK_WALLET,
          iss: config.jwt.issuer,
          aud: config.jwt.audience,
        },
        config.jwt.secret,
        {
          algorithm: 'none',
        },
      );
      const res = await request(app)
        .post('/auth/verify')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('POST /auth/logout revokes token', async () => {
      const jti = 'test-jti-123';
      const token = jwt.sign({ userId: '1', wallet: MOCK_WALLET }, config.jwt.secret, {
        expiresIn: '1h',
        algorithm: 'HS256',
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
        jwtid: jti,
      });

      // Initially valid
      let res = await request(app)
        .post('/auth/verify')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);

      // Logout
      res = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        `jwt_denylist:${jti}`,
        '1',
        'EX',
        expect.any(Number),
      );

      // Should be revoked
      res = await request(app)
        .post('/auth/verify')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });
});
