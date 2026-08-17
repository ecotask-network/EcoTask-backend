jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    notification: { create: jest.fn() },
  },
}));

jest.mock('../../src/workers/notificationWorker', () => ({
  enqueueNotificationDispatch: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import prisma from '../../src/utils/prisma';
import { notifyProofStatus } from '../../src/services/notificationService';

describe('notificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards the originating request ID to the dispatch queue', async () => {
    const mockPrisma = prisma as unknown as {
      notification: { create: jest.Mock };
    };
    mockPrisma.notification.create.mockResolvedValue({ id: 'notification-1' });
    const { enqueueNotificationDispatch } = jest.requireMock(
      '../../src/workers/notificationWorker',
    ) as { enqueueNotificationDispatch: jest.Mock };

    await notifyProofStatus('user-1', 'proof-1', 'APPROVED', 'request-1');

    expect(enqueueNotificationDispatch).toHaveBeenCalledWith(
      'notification-1',
      'request-1',
    );
  });
});
