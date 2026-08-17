import { Worker, Queue } from 'bullmq';

jest.mock('bullmq', () => ({
  Worker: jest.fn(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Queue: jest.fn(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('ioredis', () => {
  class MockRedis {
    on() {
      return this;
    }
    quit() {
      return Promise.resolve();
    }
  }
  return { __esModule: true, default: MockRedis };
});

jest.mock('../../src/config/default', () => ({
  redis: { url: 'redis://localhost:6379' },
}));

jest.mock('../../src/services/notificationDispatchService', () => ({
  dispatchNotification: jest
    .fn()
    .mockResolvedValue({ channel: 'webhook', delivered: true }),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import {
  startNotificationWorker,
  enqueueNotificationDispatch,
  getNotificationQueue,
} from '../../src/workers/notificationWorker';

describe('Notification Dispatch Worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts a worker that dispatches the notification for the job', async () => {
    startNotificationWorker();

    const processor = (Worker as unknown as jest.Mock).mock.calls[0][1] as (job: {
      data: { notificationId: string };
    }) => Promise<void>;

    const { dispatchNotification } = jest.requireMock(
      '../../src/services/notificationDispatchService',
    ) as { dispatchNotification: jest.Mock };

    await processor({ data: { notificationId: 'n-1' } });

    expect(dispatchNotification).toHaveBeenCalledWith('n-1');
  });

  it('creates the queue lazily and enqueues dispatch jobs using the outbox id as jobId', async () => {
    const queue = getNotificationQueue();
    const addSpy = (queue as unknown as { add: jest.Mock }).add;

    await enqueueNotificationDispatch('outbox-2', 'n-2');

    expect(Queue).toHaveBeenCalledWith('notification-dispatch', expect.anything());
    expect(addSpy).toHaveBeenCalledWith(
      'dispatch',
      { notificationId: 'n-2', outboxId: 'outbox-2' },
      expect.objectContaining({ attempts: 3, jobId: 'outbox-2' }),
    );
  });

  it('propagates queue errors so the outbox drainer can retry/dead-letter the row', async () => {
    const addSpy = (getNotificationQueue() as unknown as { add: jest.Mock }).add;
    addSpy.mockRejectedValueOnce(new Error('redis down'));

    await expect(enqueueNotificationDispatch('outbox-3', 'n-3')).rejects.toThrow(
      'redis down',
    );
  });
});
