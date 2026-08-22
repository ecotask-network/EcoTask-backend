import request from 'supertest';
import app from '../../src/app';
import jwt from 'jsonwebtoken';

jest.mock('../../src/workers/verificationWorker', () => ({
  enqueueVerification: jest.fn(),
}));

jest.mock('../../src/services/rateLimitService', () => ({
  rateLimiter: {
    getClient: () => ({
      get: jest.fn().mockResolvedValue(null),
    }),
  },
}));

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    proof: { findMany: jest.fn() },
  },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  user: { findUnique: jest.Mock };
  proof: { findMany: jest.Mock };
};

function userToken(userId = 'user-1'): string {
  return jwt.sign({ userId, wallet: 'GUSER...' }, 'dev-secret-change-in-production', {
    algorithm: 'HS256',
    issuer: 'ecotask-backend',
    audience: 'ecotask-users',
    jwtid: 'test-jti',
  });
}

const mockUser = {
  id: 'user-1',
  wallet: 'GUSER...',
  name: 'Ada',
  bio: null,
  avatarUrl: null,
  role: 'USER',
  createdAt: new Date('2026-01-01'),
};

describe('User Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /users/me', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/users/me');
      expect(res.status).toBe(401);
    });

    it('returns the authenticated user profile', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      const res = await request(app)
        .get('/users/me')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('user-1');
      expect(res.body.name).toBe('Ada');
    });
  });

  describe('GET /users/:id', () => {
    it('returns 404 for a missing user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const res = await request(app).get('/users/missing-id');
      expect(res.status).toBe(404);
    });

    it('does not treat "me" as an id', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      const res = await request(app)
        .get('/users/me')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-1' } }),
      );
    });
  });
});
