import request from 'supertest';
import express from 'express';
import { perUserLimiter } from '../../src/middleware/rateLimit';

jest.mock('../../src/services/rateLimitService', () => ({
  rateLimiter: { check: jest.fn() },
}));

jest.mock('../../src/config/default', () => ({
  rateLimit: {
    proofWindowMs: 3600000,
    proofMax: 20,
    claimWindowMs: 3600000,
    claimMax: 50,
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { rateLimiter } from '../../src/services/rateLimitService';

const mockCheck = (rateLimiter as unknown as { check: jest.Mock }).check;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post(
    '/limit-me',
    perUserLimiter({ windowMs: 3600000, max: 5, scope: 'test' }),
    (_req, res) => res.json({ ok: true }),
  );
  return app;
}

describe('perUserLimiter middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheck.mockResolvedValue({ allowed: true, remaining: 4, retryAfterSeconds: 3600 });
  });

  it('allows requests under the limit and sets rate limit headers', async () => {
    const res = await request(buildApp()).post('/limit-me');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('4');
  });

  it('keys the counter on the authenticated user id', async () => {
    const app = buildApp();
    const middleware = perUserLimiter({ windowMs: 60000, max: 1, scope: 'x' });

    await new Promise<void>((resolve) => {
      const req = { user: { userId: 'user-42', wallet: 'GX' }, ip: '1.2.3.4' } as never;
      const res = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnValue({ json: jest.fn() }),
      } as never;
      middleware(req, res, () => resolve());
    });

    expect(mockCheck).toHaveBeenCalledWith('rl:x:user-42', 1, 60000);
  });

  it('returns 429 with Retry-After when the limit is exceeded', async () => {
    mockCheck.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 123 });

    const res = await request(buildApp()).post('/limit-me');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('123');
    expect(res.body.error).toMatch(/too many requests/i);
  });

  it('fails open when Redis is unavailable', async () => {
    mockCheck.mockRejectedValue(new Error('connection refused'));

    const res = await request(buildApp()).post('/limit-me');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
