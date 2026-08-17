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

jest.mock('../../src/services/notificationOutboxService', () => ({
  listDeadLetteredNotifications: jest.fn(),
}));

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
  },
}));

import { listDeadLetteredNotifications } from '../../src/services/notificationOutboxService';
import prisma from '../../src/utils/prisma';

const mockListDeadLettered = listDeadLetteredNotifications as jest.Mock;

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

describe('Admin Notification Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: 'admin-id',
      role: 'admin',
    });
  });

  describe('GET /admin/notifications/dead-letter', () => {
    it('requires authentication', async () => {
      const res = await request(app).get('/admin/notifications/dead-letter');
      expect(res.status).toBe(401);
    });

    it('forbids non-admin users', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-id',
        role: 'user',
      });
      const res = await request(app)
        .get('/admin/notifications/dead-letter')
        .set('Authorization', `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });

    it('lists dead-lettered outbox rows for admins', async () => {
      mockListDeadLettered.mockResolvedValue({
        items: [
          {
            id: 'outbox-1',
            notificationId: 'notif-1',
            status: 'DEAD_LETTER',
            attempts: 3,
            lastError: 'redis down',
          },
        ],
        total: 1,
      });

      const res = await request(app)
        .get('/admin/notifications/dead-letter')
        .set('Authorization', `Bearer ${adminToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ id: 'outbox-1', status: 'DEAD_LETTER' });
      expect(res.body.meta).toEqual({ limit: 50, offset: 0, total: 1 });
      expect(mockListDeadLettered).toHaveBeenCalledWith(50, 0);
    });

    it('respects limit and offset query params, capped at the max limit', async () => {
      mockListDeadLettered.mockResolvedValue({ items: [], total: 0 });

      const res = await request(app)
        .get('/admin/notifications/dead-letter')
        .query({ limit: '9999', offset: '5' })
        .set('Authorization', `Bearer ${adminToken()}`);

      expect(res.status).toBe(200);
      expect(mockListDeadLettered).toHaveBeenCalledWith(200, 5);
    });
  });
});
