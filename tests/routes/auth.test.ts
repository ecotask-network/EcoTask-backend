import request from 'supertest';
import app from '../../src/app';
import { generateChallenge } from '../../src/services/stellarService';

import jwt from 'jsonwebtoken';
import config from '../../src/config/default';

jest.mock('../../src/workers/verificationWorker', () => ({
  enqueueVerification: jest.fn(),
}));

const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn(),
};

jest.mock('../../src/services/rateLimitService', () => ({
  rateLimiter: {
    getClient: () => mockRedisClient,
  },
}));

const MOCK_WALLET = 'GBMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCK00';

describe('Auth Routes', () => {
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

      mockRedisClient.get.mockResolvedValueOnce(null);

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

      mockRedisClient.get.mockResolvedValueOnce('1');

      // Should be revoked
      res = await request(app)
        .post('/auth/verify')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });
});
