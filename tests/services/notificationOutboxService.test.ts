import {
  drainNotificationOutbox,
  listDeadLetteredNotifications,
} from '../../src/services/notificationOutboxService';

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    notificationOutbox: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  },
}));

jest.mock('../../src/config/default', () => ({
  __esModule: true,
  default: {
    notification: {
      outboxBatchSize: 20,
      outboxMaxAttempts: 3,
    },
  },
}));

jest.mock('../../src/workers/notificationWorker', () => ({
  enqueueNotificationDispatch: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import prisma from '../../src/utils/prisma';
import { enqueueNotificationDispatch } from '../../src/workers/notificationWorker';

const mockPrisma = prisma as unknown as {
  notificationOutbox: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
};
const mockEnqueue = enqueueNotificationDispatch as jest.Mock;

function outboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'outbox-1',
    notificationId: 'notif-1',
    status: 'PENDING',
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date(0),
    createdAt: new Date(0),
    ...overrides,
  };
}

describe('NotificationOutboxService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('drainNotificationOutbox', () => {
    it('crash-recovery: enqueues a PENDING row left behind by a crashed process and marks it SENT', async () => {
      // Simulates the acceptance criterion: the proof-approval transaction
      // already committed the notification + outbox row, but the
      // in-process enqueue never happened (process crashed). A later,
      // independent drain call must still deliver it.
      const row = outboxRow();
      mockPrisma.notificationOutbox.findMany.mockResolvedValue([row]);
      mockPrisma.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.notificationOutbox.update.mockResolvedValue({});
      mockEnqueue.mockResolvedValue(undefined);

      const result = await drainNotificationOutbox();

      expect(mockPrisma.notificationOutbox.updateMany).toHaveBeenCalledWith({
        where: { id: 'outbox-1', status: 'PENDING' },
        data: { status: 'PROCESSING' },
      });
      expect(mockEnqueue).toHaveBeenCalledWith('outbox-1', 'notif-1');
      expect(mockPrisma.notificationOutbox.update).toHaveBeenCalledWith({
        where: { id: 'outbox-1' },
        data: { status: 'SENT', attempts: 1, lastError: null },
      });
      expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, deadLettered: 0 });
    });

    it('retries a failed enqueue with backoff, keeping the row PENDING for the next sweep', async () => {
      const row = outboxRow({ attempts: 0 });
      mockPrisma.notificationOutbox.findMany.mockResolvedValue([row]);
      mockPrisma.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.notificationOutbox.update.mockResolvedValue({});
      mockEnqueue.mockRejectedValue(new Error('redis down'));

      const result = await drainNotificationOutbox();

      expect(mockPrisma.notificationOutbox.update).toHaveBeenCalledWith({
        where: { id: 'outbox-1' },
        data: {
          status: 'PENDING',
          attempts: 1,
          lastError: 'redis down',
          nextAttemptAt: expect.any(Date),
        },
      });
      expect(result).toEqual({ claimed: 1, sent: 0, retried: 1, deadLettered: 0 });
    });

    it('dead-letters a row after it exhausts the configured max attempts, and it stays queryable', async () => {
      // Drive one outbox row through repeated failures until it is
      // dead-lettered, then assert it's visible via the admin-facing read.
      let attempts = 0;
      const rowId = 'outbox-dl';
      const notificationId = 'notif-dl';

      mockEnqueue.mockRejectedValue(new Error('endpoint unreachable'));
      mockPrisma.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.notificationOutbox.update.mockImplementation(({ data }) => {
        attempts = data.attempts;
        return Promise.resolve({ id: rowId, ...data });
      });

      for (let i = 0; i < 3; i++) {
        mockPrisma.notificationOutbox.findMany.mockResolvedValueOnce([
          outboxRow({ id: rowId, notificationId, attempts }),
        ]);
        await drainNotificationOutbox();
      }

      expect(attempts).toBe(3);
      expect(mockPrisma.notificationOutbox.update).toHaveBeenLastCalledWith({
        where: { id: rowId },
        data: { status: 'DEAD_LETTER', attempts: 3, lastError: 'endpoint unreachable' },
      });

      // Now assert dead-lettered rows are queryable via the admin surface.
      mockPrisma.notificationOutbox.findMany.mockResolvedValueOnce([
        outboxRow({ id: rowId, notificationId, status: 'DEAD_LETTER', attempts: 3 }),
      ]);
      mockPrisma.notificationOutbox.count.mockResolvedValueOnce(1);

      const { items, total } = await listDeadLetteredNotifications();
      expect(total).toBe(1);
      expect(items[0]).toEqual(
        expect.objectContaining({ id: rowId, status: 'DEAD_LETTER' }),
      );
    });

    it('is idempotent under a concurrent-drain race: only the winning claim enqueues the row', async () => {
      // Simulates two drain calls racing over the same PENDING row: both
      // read it before either claims it, but the conditional updateMany
      // guard ensures only the first claim succeeds.
      const row = outboxRow();
      mockPrisma.notificationOutbox.findMany.mockResolvedValue([row]);
      mockPrisma.notificationOutbox.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      mockPrisma.notificationOutbox.update.mockResolvedValue({});
      mockEnqueue.mockResolvedValue(undefined);

      const [first, second] = await Promise.all([
        drainNotificationOutbox(),
        drainNotificationOutbox(),
      ]);

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      const claimedTotal = first.claimed + second.claimed;
      expect(claimedTotal).toBe(1);
    });

    it('only fetches PENDING rows whose nextAttemptAt has elapsed', async () => {
      mockPrisma.notificationOutbox.findMany.mockResolvedValue([]);

      await drainNotificationOutbox();

      expect(mockPrisma.notificationOutbox.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'PENDING', nextAttemptAt: { lte: expect.any(Date) } },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });
  });

  describe('listDeadLetteredNotifications', () => {
    it('returns dead-lettered rows with pagination metadata', async () => {
      mockPrisma.notificationOutbox.findMany.mockResolvedValue([
        outboxRow({ id: 'dl-1', status: 'DEAD_LETTER' }),
      ]);
      mockPrisma.notificationOutbox.count.mockResolvedValue(1);

      const result = await listDeadLetteredNotifications(10, 0);

      expect(mockPrisma.notificationOutbox.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'DEAD_LETTER' }, take: 10, skip: 0 }),
      );
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });
  });
});
