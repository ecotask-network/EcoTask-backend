import request from 'supertest';
import app from '../../src/app';
import jwt from 'jsonwebtoken';

jest.mock('../../src/services/auditService', () => ({
  logAudit: jest.fn(),
}));

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
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    notification: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  user: { findUnique: jest.Mock; update: jest.Mock };
  notification: {
    findMany: jest.Mock;
    count: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
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
  mockPrisma.user.findUnique.mockResolvedValue({
    id: 'user-id',
    wallet: 'GUSER...',
    role: 'user',
  });
});

describe('Notification Routes', () => {
  describe('GET /notifications', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get('/notifications');
      expect(res.status).toBe(401);
    });

    it('returns paginated notifications for the user', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([
        { id: 'n-1', type: 'proof.approved', title: 'Proof approved', readAt: null },
      ]);
      mockPrisma.notification.count.mockResolvedValue(1);
      const res = await request(app)
        .get('/notifications')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-id' } }),
      );
    });
  });

  describe('GET /notifications/unread-count', () => {
    it('returns unread notification count', async () => {
      mockPrisma.notification.count.mockResolvedValue(3);
      const res = await request(app)
        .get('/notifications/unread-count')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 'user-id', readAt: null },
      });
    });
  });

  describe('POST /notifications/:id/read', () => {
    it('marks an owned notification as read', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({
        id: 'n-1',
        userId: 'user-id',
        readAt: null,
      });
      mockPrisma.notification.update.mockResolvedValue({
        id: 'n-1',
        userId: 'user-id',
        readAt: new Date(),
      });
      const res = await request(app)
        .post('/notifications/n-1/read')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'n-1' },
        data: { readAt: expect.any(Date) },
      });
    });

    it('returns 404 for a notification owned by another user', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue({
        id: 'n-1',
        userId: 'other-user-id',
        readAt: null,
      });
      const res = await request(app)
        .post('/notifications/n-1/read')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(404);
    });

    it('returns 404 for a missing notification', async () => {
      mockPrisma.notification.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .post('/notifications/n-missing/read')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /notifications/read-all', () => {
    it('marks all unread notifications as read', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 5 });
      const res = await request(app)
        .post('/notifications/read-all')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(5);
    });
  });

  describe('POST /notifications/preferences', () => {
    it('updates delivery channels for the logged-in user', async () => {
      mockPrisma.user.update.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.com',
        webhookUrl: 'https://hooks.example.com/ecotask',
      });
      const res = await request(app)
        .post('/notifications/preferences')
        .set('Authorization', `Bearer ${userToken()}`)
        .send({
          email: 'user@example.com',
          webhookUrl: 'https://hooks.example.com/ecotask',
        });
      expect(res.status).toBe(200);
      expect(res.body.preferences.email).toBe('user@example.com');
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-id' },
        data: {
          email: 'user@example.com',
          webhookUrl: 'https://hooks.example.com/ecotask',
        },
        select: { id: true, email: true, webhookUrl: true },
      });
    });

    it('rejects an invalid webhook URL', async () => {
      const res = await request(app)
        .post('/notifications/preferences')
        .set('Authorization', `Bearer ${userToken()}`)
        .send({ webhookUrl: 'not-a-url' });
      expect(res.status).toBe(400);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });
});
