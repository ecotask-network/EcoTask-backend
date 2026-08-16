import request from 'supertest';
import app from '../../src/app';
import jwt from 'jsonwebtoken';
import path from 'path';

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    task: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    proof: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    proofPhoto: { create: jest.fn() },
    verification: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../src/workers/verificationWorker', () => ({
  enqueueVerification: jest.fn(),
}));

jest.mock('../../src/workers/rewardWorker', () => ({
  enqueueRewardPayout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/models/task', () => ({
  completeTaskIfFull: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../src/services/notificationService', () => ({
  notifyProofStatus: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/rateLimitService', () => ({
  rateLimiter: {
    check: jest
      .fn()
      .mockResolvedValue({ allowed: true, remaining: 20, retryAfterSeconds: 0 }),
    getClient: () => ({
      get: jest.fn().mockResolvedValue(null),
    }),
  },
}));

jest.mock('../../src/services/ipfsService', () => ({
  uploadToIPFS: jest.fn().mockResolvedValue('mock-cid-test'),
  uploadMultipleToIPFS: jest.fn(),
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  task: { findUnique: jest.Mock };
  user: { findUnique: jest.Mock };
  proof: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  proofPhoto: { create: jest.Mock };
  verification: { create: jest.Mock };
  $transaction: jest.Mock;
};

function userToken(): string {
  return jwt.sign(
    { userId: 'user-id', wallet: 'GUSER...' },
    'dev-secret-change-in-production',
    {
      algorithm: 'HS256',
      issuer: 'ecotask-backend',
      audience: 'ecotask-users',
      jwtid: 'test-jti-user',
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => {
    for (const op of ops) await (op as Promise<unknown>);
    return [];
  });
});

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

describe('Proof Routes', () => {
  describe('POST /proofs', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/proofs')
        .field('taskId', VALID_UUID)
        .attach('photos', path.join(__dirname, '../fixtures/test-proof.jpg'));
      expect(res.status).toBe(401);
    });

    it('returns 404 when task does not exist', async () => {
      mockPrisma.task.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('task not found');
    });

    it('returns 400 when task is not active', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ id: 'task-1', status: 'COMPLETED' });
      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('task is not active');
    });

    it('returns 201 and creates proof with photo', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ id: 'task-1', status: 'ACTIVE' });
      mockPrisma.proof.create.mockResolvedValue({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        status: 'PENDING',
      });
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: 'proof-1',
        status: 'PENDING',
        photos: [{ id: 'photo-1', cid: 'mock-cid-test', filename: 'test-proof.jpg' }],
        verifications: [],
      });
      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID)
        .field('lat', '-1.2921')
        .field('lng', '36.8219')
        .attach('photos', path.join(__dirname, '../fixtures/test-proof.jpg'));
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PENDING');
    });
  });

  describe('GET /proofs/:id', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/proofs/some-id');
      expect(res.status).toBe(401);
    });

    it('returns proof with photos and verifications', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: 'proof-1',
        userId: 'user-id',
        status: 'PENDING',
        photos: [{ id: 'photo-1', cid: 'mock-cid', filename: 'test.jpg' }],
        verifications: [],
      });
      const res = await request(app)
        .get('/proofs/proof-1')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('proof-1');
      expect(res.body.photos).toHaveLength(1);
    });

    it("forbids access to another user's proof", async () => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: 'proof-1',
        userId: 'other-user-id',
        status: 'PENDING',
        photos: [],
        verifications: [],
      });
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
      const res = await request(app)
        .get('/proofs/proof-1')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });

    it('allows admins to view any proof', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: 'proof-1',
        userId: 'other-user-id',
        status: 'PENDING',
        photos: [],
        verifications: [],
      });
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
      const res = await request(app)
        .get('/proofs/proof-1')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent proof', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get('/proofs/non-existent')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /proofs/user/:userId', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/proofs/user/some-user-id');
      expect(res.status).toBe(401);
    });

    it('returns paginated proofs for user', async () => {
      mockPrisma.proof.findMany.mockResolvedValue([
        { id: 'proof-1', status: 'APPROVED', photos: [], task: { title: 'Plant Trees' } },
      ]);
      mockPrisma.proof.count.mockResolvedValue(1);
      const res = await request(app)
        .get('/proofs/user/user-id')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
    });

    it('caps limit at 100', async () => {
      mockPrisma.proof.findMany.mockResolvedValue([]);
      mockPrisma.proof.count.mockResolvedValue(0);
      const res = await request(app)
        .get('/proofs/user/user-id')
        .query({ limit: '9999' })
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(mockPrisma.proof.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('returns 400 for invalid pagination params', async () => {
      const res = await request(app)
        .get('/proofs/user/user-id')
        .query({ page: '-1' })
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(400);
    });
  });

  describe('POST /proofs capacity enforcement', () => {
    it('returns 409 when the task has reached maxCompletions', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        status: 'ACTIVE',
        maxCompletions: 5,
      });
      mockPrisma.proof.count.mockResolvedValue(5);
      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('task has reached maximum completions');
      expect(mockPrisma.proof.create).not.toHaveBeenCalled();
    });

    it('allows submission when capacity is not reached', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        status: 'ACTIVE',
        maxCompletions: 5,
      });
      mockPrisma.proof.count.mockResolvedValue(2);
      mockPrisma.proof.create.mockResolvedValue({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        status: 'PENDING',
      });
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: 'proof-1',
        status: 'PENDING',
        photos: [],
        verifications: [],
      });
      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID);
      expect(res.status).toBe(201);
    });
  });

  describe('GET /proofs/review', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/proofs/review');
      expect(res.status).toBe(401);
    });

    it('forbids non-admin users', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
      const res = await request(app)
        .get('/proofs/review')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });

    it('lists pending proofs for admins', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
      mockPrisma.proof.findMany.mockResolvedValue([
        { id: 'proof-1', status: 'VERIFYING', photos: [], user: {}, task: {} },
      ]);
      mockPrisma.proof.count.mockResolvedValue(1);
      const res = await request(app)
        .get('/proofs/review')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(mockPrisma.proof.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: { in: ['PENDING', 'VERIFYING'] } },
        }),
      );
    });
  });

  describe('POST /proofs/:id/review', () => {
    const adminToken = (): string =>
      jwt.sign(
        { userId: 'admin-id', wallet: 'GADMIN...' },
        'dev-secret-change-in-production',
        {
          algorithm: 'HS256',
          issuer: 'ecotask-backend',
          audience: 'ecotask-users',
          jwtid: 'test-jti-admin',
        },
      );

    it('forbids non-admin users', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
      const res = await request(app)
        .post('/proofs/proof-1/review')
        .set('Authorization', `Bearer ${userToken()}`)
        .send({ verdict: 'approved' });
      expect(res.status).toBe(403);
    });

    it('returns 404 for a missing proof', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
      mockPrisma.proof.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .post('/proofs/proof-missing/review')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ verdict: 'approved' });
      expect(res.status).toBe(404);
    });

    it('returns 409 for a proof already in a final state', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        status: 'APPROVED',
      });
      const res = await request(app)
        .post('/proofs/proof-1/review')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ verdict: 'approved' });
      expect(res.status).toBe(409);
    });

    it('rejects a proof and records the verification', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        status: 'VERIFYING',
      });
      mockPrisma.proof.update.mockResolvedValue({});
      mockPrisma.verification.create.mockResolvedValue({});
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        id: 'proof-1',
        status: 'REJECTED',
        photos: [],
        verifications: [],
      });

      const res = await request(app)
        .post('/proofs/proof-1/review')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ verdict: 'rejected', notes: 'GPS outside radius' });
      expect(res.status).toBe(200);
      expect(mockPrisma.proof.update).toHaveBeenCalledWith({
        where: { id: 'proof-1' },
        data: { status: 'REJECTED' },
      });
      expect(mockPrisma.verification.create).toHaveBeenCalledWith({
        data: {
          proofId: 'proof-1',
          verifierId: 'admin-id',
          verdict: 'rejected',
          notes: 'GPS outside radius',
        },
      });
    });

    it('approves a proof, completes capacity and enqueues the payout', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        status: 'VERIFYING',
      });
      mockPrisma.proof.update.mockResolvedValue({});
      mockPrisma.verification.create.mockResolvedValue({});
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        id: 'proof-1',
        status: 'APPROVED',
        photos: [],
        verifications: [],
      });

      const { completeTaskIfFull } = jest.requireMock('../../src/models/task') as {
        completeTaskIfFull: jest.Mock;
      };
      completeTaskIfFull.mockResolvedValue(true);
      const { enqueueRewardPayout } = jest.requireMock(
        '../../src/workers/rewardWorker',
      ) as { enqueueRewardPayout: jest.Mock };

      const res = await request(app)
        .post('/proofs/proof-1/review')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ verdict: 'approved' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APPROVED');
      expect(completeTaskIfFull).toHaveBeenCalledWith('task-1');
      expect(enqueueRewardPayout).toHaveBeenCalledWith('proof-1');
    });
  });
});
