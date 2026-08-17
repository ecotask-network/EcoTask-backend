import type { Prisma } from '@prisma/client';
import {
  createNotification,
  notifyProofStatus,
} from '../../src/services/notificationService';

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    notification: { create: jest.fn() },
    notificationOutbox: { create: jest.fn() },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  notification: { create: jest.Mock };
  notificationOutbox: { create: jest.Mock };
};

describe('NotificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createNotification', () => {
    it('persists the notification and an outbox row using the default prisma client', async () => {
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-1' });
      mockPrisma.notificationOutbox.create.mockResolvedValue({ id: 'outbox-1' });

      const result = await createNotification({
        userId: 'user-1',
        type: 'proof.approved',
        title: 'Proof approved',
        body: 'nice work',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          type: 'proof.approved',
          title: 'Proof approved',
          body: 'nice work',
        },
      });
      expect(mockPrisma.notificationOutbox.create).toHaveBeenCalledWith({
        data: { notificationId: 'notif-1' },
      });
      expect(result).toEqual({ notificationId: 'notif-1', outboxId: 'outbox-1' });
    });

    it('persists the originating request ID with the outbox row', async () => {
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-request' });
      mockPrisma.notificationOutbox.create.mockResolvedValue({
        id: 'outbox-request',
      });

      await createNotification(
        {
          userId: 'user-request',
          type: 'proof.approved',
          title: 'Proof approved',
        },
        'request-1',
      );

      expect(mockPrisma.notificationOutbox.create).toHaveBeenCalledWith({
        data: {
          notificationId: 'notif-request',
          requestId: 'request-1',
        },
      });
    });

    it('uses the provided transaction client instead of the default prisma client', async () => {
      const tx = {
        notification: { create: jest.fn().mockResolvedValue({ id: 'notif-2' }) },
        notificationOutbox: { create: jest.fn().mockResolvedValue({ id: 'outbox-2' }) },
      };

      const result = await createNotification(
        { userId: 'user-2', type: 'proof.rejected', title: 'Proof rejected' },
        tx as unknown as Prisma.TransactionClient,
      );

      expect(tx.notification.create).toHaveBeenCalled();
      expect(tx.notificationOutbox.create).toHaveBeenCalledWith({
        data: { notificationId: 'notif-2' },
      });
      // The default (module-level) prisma client must never be touched when a
      // tx is supplied — otherwise the write would escape the caller's
      // transaction.
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      expect(mockPrisma.notificationOutbox.create).not.toHaveBeenCalled();
      expect(result).toEqual({ notificationId: 'notif-2', outboxId: 'outbox-2' });
    });

    it('propagates errors instead of swallowing them, so a wrapping transaction rolls back', async () => {
      mockPrisma.notification.create.mockRejectedValue(new Error('db unreachable'));

      await expect(
        createNotification({ userId: 'user-3', type: 'proof.approved', title: 'x' }),
      ).rejects.toThrow('db unreachable');

      // The outbox row must not be created if the notification write failed.
      expect(mockPrisma.notificationOutbox.create).not.toHaveBeenCalled();
    });

    it('propagates errors from the outbox row write too', async () => {
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-4' });
      mockPrisma.notificationOutbox.create.mockRejectedValue(
        new Error('outbox write failed'),
      );

      await expect(
        createNotification({ userId: 'user-4', type: 'proof.approved', title: 'x' }),
      ).rejects.toThrow('outbox write failed');
    });
  });

  describe('notifyProofStatus', () => {
    it('creates an approved notification and forwards the tx client', async () => {
      const tx = {
        notification: { create: jest.fn().mockResolvedValue({ id: 'notif-5' }) },
        notificationOutbox: { create: jest.fn().mockResolvedValue({ id: 'outbox-5' }) },
      };

      await notifyProofStatus(
        'user-5',
        'proof-5',
        'APPROVED',
        tx as unknown as Prisma.TransactionClient,
      );

      expect(tx.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-5',
          type: 'proof.approved',
          title: 'Proof approved',
        }),
      });
    });

    it('creates a rejected notification when status is not APPROVED', async () => {
      mockPrisma.notification.create.mockResolvedValue({ id: 'notif-6' });
      mockPrisma.notificationOutbox.create.mockResolvedValue({ id: 'outbox-6' });

      await notifyProofStatus('user-6', 'proof-6', 'REJECTED');

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-6',
          type: 'proof.rejected',
          title: 'Proof rejected',
        }),
      });
    });
  });
});
