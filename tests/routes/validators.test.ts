import request from 'supertest';
import app from '../../src/app';
import jwt from 'jsonwebtoken';

jest.mock('../../src/workers/verificationWorker', () => ({
  enqueueVerification: jest.fn(),
}));

jest.mock('../../src/workers/rewardWorker', () => ({
  enqueueRewardPayout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/notificationService', () => ({
  notifyProofStatus: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/rateLimitService', () => ({
  rateLimiter: {
    check: jest
      .fn()
      .mockResolvedValue({ allowed: true, remaining: 50, retryAfterSeconds: 0 }),
    getClient: () => ({
      get: jest.fn().mockResolvedValue(null),
    }),
  },
}));

jest.mock('../../src/models/task', () => ({
  completeTaskIfFull: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../src/services/validatorService', () => ({
  assignValidators: jest.fn(),
  listPendingReviews: jest.fn(),
  castVote: jest.fn(),
  resolveQuorum: jest.fn(),
}));

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    validatorVote: {
      count: jest.fn(),
      createMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    proof: { findUnique: jest.fn(), update: jest.fn() },
    verification: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  user: { findUnique: jest.Mock; findMany: jest.Mock; update: jest.Mock };
  proof: { findUnique: jest.Mock; update: jest.Mock };
};

function token(userId: string, wallet: string): string {
  return jwt.sign({ userId, wallet }, 'dev-secret-change-in-production', {
    algorithm: 'HS256',
    issuer: 'ecotask-backend',
    audience: 'ecotask-users',
    jwtid: 'test-jti',
  });
}

describe('Validator Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /validators (admin)', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/validators');
      expect(res.status).toBe(401);
    });

    it('forbids non-admin users', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
      const res = await request(app)
        .get('/validators')
        .set('Authorization', `Bearer ${token('user-id', 'GUSER')}`);
      expect(res.status).toBe(403);
    });

    it('lists validators with their reputation', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: 'v1',
          wallet: 'GV',
          name: 'Validator One',
          validatorReputation: 5,
          reviewCount: 3,
        },
      ]);
      const res = await request(app)
        .get('/validators')
        .set('Authorization', `Bearer ${token('admin-id', 'GADMIN')}`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.data[0].validatorReputation).toBe(5);
    });
  });

  describe('POST /validators/:userId/activate', () => {
    it('promotes a user to validator', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ role: 'admin' });
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', role: 'user' });
      mockPrisma.user.update.mockResolvedValue({
        id: 'u-1',
        wallet: 'GU',
        role: 'validator',
      });
      const res = await request(app)
        .post('/validators/u-1/activate')
        .set('Authorization', `Bearer ${token('admin-id', 'GADMIN')}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('validator');
    });

    it('returns 404 for a missing user', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ role: 'admin' });
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      const res = await request(app)
        .post('/validators/missing/activate')
        .set('Authorization', `Bearer ${token('admin-id', 'GADMIN')}`)
        .send({});
      expect(res.status).toBe(404);
    });
  });

  describe('POST /validators/:userId/deactivate', () => {
    it('demotes a validator back to user', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ role: 'admin' });
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u-1', role: 'validator' });
      mockPrisma.user.update.mockResolvedValue({ id: 'u-1', wallet: 'GU', role: 'user' });
      const res = await request(app)
        .post('/validators/u-1/deactivate')
        .set('Authorization', `Bearer ${token('admin-id', 'GADMIN')}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('user');
    });

    it('refuses to demote an admin', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'u-1', role: 'admin' });
      const res = await request(app)
        .post('/validators/u-1/deactivate')
        .set('Authorization', `Bearer ${token('admin-id', 'GADMIN')}`)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /validator/reviews', () => {
    it('requires validator role', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
      const res = await request(app)
        .get('/validator/reviews')
        .set('Authorization', `Bearer ${token('user-id', 'GUSER')}`);
      expect(res.status).toBe(403);
    });

    it('returns the pending reviews assigned to the validator', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'validator' });
      const { listPendingReviews } = jest.requireMock(
        '../../src/services/validatorService',
      ) as { listPendingReviews: jest.Mock };
      listPendingReviews.mockResolvedValue([{ id: 'vote-1', proof: { id: 'proof-1' } }]);

      const res = await request(app)
        .get('/validator/reviews')
        .set('Authorization', `Bearer ${token('v-id', 'GVAL')}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(listPendingReviews).toHaveBeenCalledWith('v-id');
    });
  });

  describe('POST /validator/reviews/:proofId', () => {
    it('requires validator role', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
      const res = await request(app)
        .post('/validator/reviews/proof-1')
        .set('Authorization', `Bearer ${token('user-id', 'GUSER')}`)
        .send({ verdict: 'approved' });
      expect(res.status).toBe(403);
    });

    it('returns 400 for an invalid verdict', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'validator' });
      const res = await request(app)
        .post('/validator/reviews/proof-1')
        .set('Authorization', `Bearer ${token('v-id', 'GVAL')}`)
        .send({ verdict: 'maybe' });
      expect(res.status).toBe(400);
    });

    it('casts the vote and returns the quorum outcome', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'validator' });
      const { castVote } = jest.requireMock('../../src/services/validatorService') as {
        castVote: jest.Mock;
      };
      castVote.mockResolvedValue({ finalized: true, status: 'APPROVED' });

      const res = await request(app)
        .post('/validator/reviews/proof-1')
        .set('Authorization', `Bearer ${token('v-id', 'GVAL')}`)
        .send({ verdict: 'approved', notes: 'matches task location' });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toEqual({ finalized: true, status: 'APPROVED' });
      expect(castVote).toHaveBeenCalledWith(
        'proof-1',
        'v-id',
        'approved',
        'matches task location',
        res.headers['x-request-id'],
      );
    });

    it('returns 409 when the vote was already cast', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'validator' });
      const { castVote } = jest.requireMock('../../src/services/validatorService') as {
        castVote: jest.Mock;
      };
      castVote.mockRejectedValue(new Error('Vote already cast'));

      const res = await request(app)
        .post('/validator/reviews/proof-1')
        .set('Authorization', `Bearer ${token('v-id', 'GVAL')}`)
        .send({ verdict: 'rejected' });
      expect(res.status).toBe(409);
    });

    it('returns 404 when the validator has no assignment', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'validator' });
      const { castVote } = jest.requireMock('../../src/services/validatorService') as {
        castVote: jest.Mock;
      };
      castVote.mockRejectedValue(new Error('Vote not found for this validator'));

      const res = await request(app)
        .post('/validator/reviews/proof-1')
        .set('Authorization', `Bearer ${token('v-id', 'GVAL')}`)
        .send({ verdict: 'approved' });
      expect(res.status).toBe(404);
    });
  });
});
