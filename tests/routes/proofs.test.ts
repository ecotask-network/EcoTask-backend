import request from 'supertest';
import app from '../../src/app';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';

jest.mock('../../src/services/auditService', () => ({
  logAudit: jest.fn(),
}));

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    task: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    taskClaim: { findFirst: jest.fn() },
    proof: {
      create: jest.fn(),
      delete: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    proofPhoto: { create: jest.fn(), deleteMany: jest.fn() },
    verification: { create: jest.fn() },
    rewardPayout: { create: jest.fn() },
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
  claimCompletionSlot: jest
    .fn()
    .mockResolvedValue({ claimed: true, taskCompleted: false }),
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
  taskClaim: { findFirst: jest.Mock };
  proof: {
    create: jest.Mock;
    delete: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  proofPhoto: { create: jest.Mock; deleteMany: jest.Mock };
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
  const { uploadToIPFS } = jest.requireMock('../../src/services/ipfsService') as {
    uploadToIPFS: jest.Mock;
  };
  uploadToIPFS.mockResolvedValue('mock-cid-test');
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
    // Interactive-transaction form used by submitProof: the callback receives
    // the mock client itself, so tx.task/tx.taskClaim/... hit the same mocks.
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)(mockPrisma);
    }
    const ops = arg as Promise<unknown>[];
    for (const op of ops) await op;
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

    it('returns 201 and creates proof with photo tied to the active claim', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ id: 'task-1', status: 'ACTIVE' });
      mockPrisma.taskClaim.findFirst.mockResolvedValue({ id: 'claim-1' });
      mockPrisma.proof.create.mockResolvedValue({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        claimId: 'claim-1',
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
      expect(mockPrisma.taskClaim.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            taskId: VALID_UUID,
            userId: 'user-id',
            status: 'ACTIVE',
            expiresAt: { gt: expect.any(Date) },
          },
        }),
      );
      expect(mockPrisma.proof.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            claimId: 'claim-1',
            photos: {
              create: [
                expect.objectContaining({
                  cid: 'mock-cid-test',
                  filename: 'test-proof.jpg',
                }),
              ],
            },
          }),
          include: { photos: true, verifications: true },
        }),
      );
      expect(mockPrisma.proofPhoto.create).not.toHaveBeenCalled();
      expect(res.headers['x-request-id']).toBeDefined();
      const { enqueueVerification } = jest.requireMock(
        '../../src/workers/verificationWorker',
      ) as { enqueueVerification: jest.Mock };
      expect(enqueueVerification).toHaveBeenCalledWith(
        'proof-1',
        res.headers['x-request-id'],
      );
    });

    it('rejects submission when the submitter holds no active claim', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ id: 'task-1', status: 'ACTIVE' });
      mockPrisma.taskClaim.findFirst.mockResolvedValue(null);
      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('active claim required to submit proof for this task');
      expect(mockPrisma.proof.create).not.toHaveBeenCalled();
    });

    it('rejects submission when the claim has expired, before the sweeper runs', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ id: 'task-1', status: 'ACTIVE' });
      // The claim row still has status 'active' (the background expiry sweeper
      // has not run yet), but its expiresAt is in the past. Enforcement must
      // happen at submit time, not only on the sweep.
      mockPrisma.taskClaim.findFirst.mockResolvedValue(null);
      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('active claim required to submit proof for this task');
      expect(mockPrisma.taskClaim.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ACTIVE',
            expiresAt: { gt: expect.any(Date) },
          }),
        }),
      );
      expect(mockPrisma.proof.create).not.toHaveBeenCalled();
    });

    it('removes the temp file and creates no rows when IPFS upload fails', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        status: 'ACTIVE',
        lat: -1.2921,
        lng: 36.8219,
        radiusMeters: 100,
      });
      mockPrisma.taskClaim.findFirst.mockResolvedValue({ id: 'claim-1' });
      const uploadPaths: string[] = [];
      const { uploadToIPFS } = jest.requireMock('../../src/services/ipfsService') as {
        uploadToIPFS: jest.Mock;
      };
      uploadToIPFS.mockImplementationOnce(async (filePath: string) => {
        uploadPaths.push(filePath);
        throw new Error('IPFS unavailable');
      });

      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID)
        .attach('photos', path.join(__dirname, '../fixtures/test-proof.jpg'));

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('failed to process proof photos');
      expect(mockPrisma.proof.create).not.toHaveBeenCalled();
      expect(mockPrisma.proofPhoto.create).not.toHaveBeenCalled();
      expect(uploadPaths).toHaveLength(1);
      expect(uploadPaths.every((filePath) => !fs.existsSync(filePath))).toBe(true);
    });

    it('does not persist a partial photo set when the second upload fails', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        status: 'ACTIVE',
        lat: -1.2921,
        lng: 36.8219,
        radiusMeters: 100,
      });
      mockPrisma.taskClaim.findFirst.mockResolvedValue({ id: 'claim-1' });
      const uploadPaths: string[] = [];
      const { uploadToIPFS } = jest.requireMock('../../src/services/ipfsService') as {
        uploadToIPFS: jest.Mock;
      };
      uploadToIPFS.mockImplementation(async (filePath: string) => {
        uploadPaths.push(filePath);
        if (uploadPaths.length === 2) throw new Error('second upload failed');
        return `cid-${uploadPaths.length}`;
      });

      const fixture = path.join(__dirname, '../fixtures/test-proof.jpg');
      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID)
        .attach('photos', fixture)
        .attach('photos', fixture)
        .attach('photos', fixture);

      expect(res.status).toBe(500);
      expect(mockPrisma.proof.create).not.toHaveBeenCalled();
      expect(mockPrisma.proofPhoto.create).not.toHaveBeenCalled();
      expect(uploadPaths).toHaveLength(3);
      expect(uploadPaths.every((filePath) => !fs.existsSync(filePath))).toBe(true);
    });

    it('allows a clean retry after an upload failure', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        status: 'ACTIVE',
        lat: -1.2921,
        lng: 36.8219,
        radiusMeters: 100,
      });
      mockPrisma.taskClaim.findFirst.mockResolvedValue({ id: 'claim-1' });
      mockPrisma.proof.create.mockResolvedValue({
        id: 'proof-retry',
        userId: 'user-id',
        taskId: 'task-1',
        claimId: 'claim-1',
        status: 'PENDING',
        photos: [{ id: 'photo-retry', cid: 'retry-cid' }],
        verifications: [],
      });
      const uploadPaths: string[] = [];
      const { uploadToIPFS } = jest.requireMock('../../src/services/ipfsService') as {
        uploadToIPFS: jest.Mock;
      };
      uploadToIPFS
        .mockImplementationOnce(async (filePath: string) => {
          uploadPaths.push(filePath);
          throw new Error('temporary IPFS failure');
        })
        .mockImplementationOnce(async (filePath: string) => {
          uploadPaths.push(filePath);
          return 'retry-cid';
        });

      const fixture = path.join(__dirname, '../fixtures/test-proof.jpg');
      const first = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID)
        .attach('photos', fixture);
      expect(first.status).toBe(500);
      expect(mockPrisma.proof.create).not.toHaveBeenCalled();

      const second = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID)
        .attach('photos', fixture);

      expect(second.status).toBe(201);
      expect(second.body.id).toBe('proof-retry');
      expect(mockPrisma.proof.create).toHaveBeenCalledTimes(1);
      expect(uploadPaths).toHaveLength(2);
      expect(uploadPaths.every((filePath) => !fs.existsSync(filePath))).toBe(true);
    });

    it('removes the committed proof when verification enqueue fails', async () => {
      mockPrisma.task.findUnique.mockResolvedValue({
        id: 'task-1',
        status: 'ACTIVE',
        lat: -1.2921,
        lng: 36.8219,
        radiusMeters: 100,
      });
      mockPrisma.taskClaim.findFirst.mockResolvedValue({ id: 'claim-1' });
      mockPrisma.proof.create.mockResolvedValue({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        claimId: 'claim-1',
        status: 'PENDING',
        photos: [{ id: 'photo-1', cid: 'mock-cid-test' }],
        verifications: [],
      });
      const { enqueueVerification } = jest.requireMock(
        '../../src/workers/verificationWorker',
      ) as { enqueueVerification: jest.Mock };
      enqueueVerification.mockRejectedValueOnce(new Error('queue unavailable'));
      const uploadPaths: string[] = [];
      const { uploadToIPFS } = jest.requireMock('../../src/services/ipfsService') as {
        uploadToIPFS: jest.Mock;
      };
      uploadToIPFS.mockImplementationOnce(async (filePath: string) => {
        uploadPaths.push(filePath);
        return 'mock-cid-test';
      });

      const res = await request(app)
        .post('/proofs')
        .set('Authorization', `Bearer ${userToken()}`)
        .field('taskId', VALID_UUID)
        .attach('photos', path.join(__dirname, '../fixtures/test-proof.jpg'));

      expect(res.status).toBe(500);
      expect(mockPrisma.proofPhoto.deleteMany).toHaveBeenCalledWith({
        where: { proofId: 'proof-1' },
      });
      expect(mockPrisma.proof.delete).toHaveBeenCalledWith({
        where: { id: 'proof-1' },
      });
      expect(uploadPaths.every((filePath) => !fs.existsSync(filePath))).toBe(true);
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
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
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
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
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
        completedCount: 5,
      });
      mockPrisma.taskClaim.findFirst.mockResolvedValue({ id: 'claim-1' });
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
        completedCount: 2,
      });
      mockPrisma.taskClaim.findFirst.mockResolvedValue({ id: 'claim-1' });
      mockPrisma.proof.create.mockResolvedValue({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        claimId: 'claim-1',
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
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
      const res = await request(app)
        .get('/proofs/review')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });

    it('lists pending proofs for admins', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
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
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
      const res = await request(app)
        .post('/proofs/proof-1/review')
        .set('Authorization', `Bearer ${userToken()}`)
        .send({ verdict: 'approved' });
      expect(res.status).toBe(403);
    });

    it('returns 404 for a missing proof', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.proof.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .post('/proofs/proof-missing/review')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ verdict: 'approved' });
      expect(res.status).toBe(404);
    });

    it('returns 409 for a proof already in a final state', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
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
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        status: 'VERIFYING',
      });
      mockPrisma.proof.updateMany.mockResolvedValue({ count: 1 });
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
      expect(mockPrisma.proof.updateMany).toHaveBeenCalledWith({
        where: { id: 'proof-1', status: { in: ['PENDING', 'VERIFYING'] } },
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

    it('approves a proof, completes capacity and creates payout outbox row', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        id: 'proof-1',
        userId: 'user-id',
        taskId: 'task-1',
        status: 'VERIFYING',
      });
      mockPrisma.proof.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.verification.create.mockResolvedValue({});
      mockPrisma.rewardPayout.create.mockResolvedValue({});
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        id: 'proof-1',
        status: 'APPROVED',
        photos: [],
        verifications: [],
      });

      const { claimCompletionSlot } = jest.requireMock('../../src/models/task') as {
        claimCompletionSlot: jest.Mock;
      };
      claimCompletionSlot.mockResolvedValue({ claimed: true, taskCompleted: true });

      const res = await request(app)
        .post('/proofs/proof-1/review')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ verdict: 'approved' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APPROVED');
      expect(claimCompletionSlot).toHaveBeenCalledWith(mockPrisma, 'task-1');
      expect(mockPrisma.rewardPayout.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ proofId: 'proof-1' }),
      });
    });
  });
});
