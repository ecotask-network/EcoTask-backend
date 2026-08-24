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

jest.mock('../../src/services/queueAdminService', () => {
  class QueueAdminError extends Error {}
  class JobNotFoundError extends QueueAdminError {}
  class JobNotFailedError extends QueueAdminError {}
  return {
    ADMIN_QUEUE_NAMES: ['proof-verification', 'reward-payout'],
    isAdminQueueName: (name: string) =>
      name === 'proof-verification' || name === 'reward-payout',
    getQueueCounts: jest.fn(),
    listFailedJobs: jest.fn(),
    retryFailedJob: jest.fn(),
    QueueAdminError,
    JobNotFoundError,
    JobNotFailedError,
  };
});

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
  },
}));

import {
  getQueueCounts,
  JobNotFoundError,
  JobNotFailedError,
  listFailedJobs,
  retryFailedJob,
} from '../../src/services/queueAdminService';
import prisma from '../../src/utils/prisma';

const mockGetQueueCounts = getQueueCounts as jest.Mock;
const mockListFailedJobs = listFailedJobs as jest.Mock;
const mockRetryFailedJob = retryFailedJob as jest.Mock;

function adminToken(): string {
  return jwt.sign(
    { userId: 'admin-id', wallet: 'GADMIN...' },
    'dev-secret-change-in-production',
    {
      algorithm: 'HS256',
      issuer: 'ecotask-backend',
      audience: 'ecotask-users',
      jwtid: 'test-jti-admin',
    },
  );
}

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

describe('Admin Queue Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'admin-id',
      role: 'admin',
    });
  });

  describe('GET /admin/queues', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/admin/queues');
      expect(res.status).toBe(401);
    });

    it('forbids non-admin users', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-id',
        role: 'user',
      });
      const res = await request(app)
        .get('/admin/queues')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });

    it('reports counts for the verification and reward queues', async () => {
      mockGetQueueCounts.mockImplementation((queueName: string) =>
        Promise.resolve({
          queue: queueName,
          waiting: queueName === 'proof-verification' ? 5 : 2,
          active: 1,
          completed: 1000,
          failed: queueName === 'proof-verification' ? 3 : 0,
          delayed: 0,
          paused: 0,
        }),
      );

      const res = await request(app)
        .get('/admin/queues')
        .set('Authorization', `Bearer ${adminToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toMatchObject({
        queue: 'proof-verification',
        waiting: 5,
        failed: 3,
      });
      expect(res.body.data[1]).toMatchObject({
        queue: 'reward-payout',
        waiting: 2,
        failed: 0,
      });
      expect(mockGetQueueCounts).toHaveBeenCalledWith('proof-verification');
      expect(mockGetQueueCounts).toHaveBeenCalledWith('reward-payout');
    });
  });

  describe('GET /admin/queues/:queueName/failed', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/admin/queues/proof-verification/failed');
      expect(res.status).toBe(401);
    });

    it('forbids non-admin users', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-id',
        role: 'user',
      });
      const res = await request(app)
        .get('/admin/queues/proof-verification/failed')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });

    it('rejects unknown queue names', async () => {
      const res = await request(app)
        .get('/admin/queues/notification-dispatch/failed')
        .set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(400);
      expect(mockListFailedJobs).not.toHaveBeenCalled();
    });

    it('lists failed jobs with pagination meta', async () => {
      mockListFailedJobs.mockResolvedValue({
        items: [
          {
            id: 'job-1',
            name: 'verify',
            data: { proofId: 'proof-1' },
            attemptsMade: 3,
            failedReason: 'injected failure',
            stacktrace: ['Error: injected failure'],
            timestamp: 1700000000000,
            finishedOn: 1700000010000,
          },
        ],
        total: 1,
      });

      const res = await request(app)
        .get('/admin/queues/proof-verification/failed')
        .set('Authorization', `Bearer ${adminToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: 'job-1',
        failedReason: 'injected failure',
        attemptsMade: 3,
      });
      expect(res.body.meta).toEqual({
        queue: 'proof-verification',
        limit: 50,
        offset: 0,
        total: 1,
      });
      expect(mockListFailedJobs).toHaveBeenCalledWith('proof-verification', 50, 0);
    });

    it('respects limit and offset query params, capped at the max limit', async () => {
      mockListFailedJobs.mockResolvedValue({ items: [], total: 0 });

      const res = await request(app)
        .get('/admin/queues/reward-payout/failed')
        .query({ limit: '9999', offset: '5' })
        .set('Authorization', `Bearer ${adminToken()}`);

      expect(res.status).toBe(200);
      expect(mockListFailedJobs).toHaveBeenCalledWith('reward-payout', 100, 5);
    });
  });

  describe('POST /admin/queues/:queueName/jobs/:jobId/retry', () => {
    it('requires authentication', async () => {
      const res = await request(app).post(
        '/admin/queues/proof-verification/jobs/job-1/retry',
      );
      expect(res.status).toBe(401);
    });

    it('forbids non-admin users', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-id',
        role: 'user',
      });
      const res = await request(app)
        .post('/admin/queues/proof-verification/jobs/job-1/retry')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });

    it('rejects unknown queue names', async () => {
      const res = await request(app)
        .post('/admin/queues/notification-dispatch/jobs/job-1/retry')
        .set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(400);
      expect(mockRetryFailedJob).not.toHaveBeenCalled();
    });

    it('retries a failed job', async () => {
      mockRetryFailedJob.mockResolvedValue({
        queue: 'proof-verification',
        jobId: 'job-1',
      });

      const res = await request(app)
        .post('/admin/queues/proof-verification/jobs/job-1/retry')
        .set('Authorization', `Bearer ${adminToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ queue: 'proof-verification', jobId: 'job-1' });
      expect(mockRetryFailedJob).toHaveBeenCalledWith('proof-verification', 'job-1');
    });

    it('returns 404 when the job does not exist', async () => {
      mockRetryFailedJob.mockRejectedValue(
        new JobNotFoundError('Job missing not found in queue proof-verification'),
      );

      const res = await request(app)
        .post('/admin/queues/proof-verification/jobs/missing/retry')
        .set('Authorization', `Bearer ${adminToken()}`);

      expect(res.status).toBe(404);
    });

    it('returns 409 when the job is no longer failed', async () => {
      mockRetryFailedJob.mockRejectedValue(
        new JobNotFailedError('Job job-1 is not in the failed state'),
      );

      const res = await request(app)
        .post('/admin/queues/proof-verification/jobs/job-1/retry')
        .set('Authorization', `Bearer ${adminToken()}`);

      expect(res.status).toBe(409);
    });
  });
});
