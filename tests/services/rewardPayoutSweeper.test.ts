jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    rewardPayout: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../../src/workers/rewardWorker', () => ({
  enqueueRewardPayout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/config/default', () => ({
  notification: {
    outboxBatchSize: 20,
    outboxSweepIntervalMs: 30000,
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { drainRewardPayouts } from '../../src/services/rewardPayoutSweeper';
import prisma from '../../src/utils/prisma';
import { enqueueRewardPayout } from '../../src/workers/rewardWorker';

const mockPrisma = prisma as unknown as {
  rewardPayout: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
  };
};
const mockEnqueue = enqueueRewardPayout as jest.Mock;

describe('RewardPayoutSweeper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('enqueues PENDING payout rows to BullMQ', async () => {
    mockPrisma.rewardPayout.findMany.mockResolvedValueOnce([
      {
        id: 'payout-1',
        proofId: 'proof-1',
        requestId: 'req-1',
        status: 'PENDING',
        attempts: 0,
      },
      {
        id: 'payout-2',
        proofId: 'proof-2',
        requestId: null,
        status: 'PENDING',
        attempts: 0,
      },
    ]);
    mockPrisma.rewardPayout.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.rewardPayout.findMany.mockResolvedValueOnce([]);

    const result = await drainRewardPayouts();

    expect(result.enqueued).toBe(2);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(mockEnqueue).toHaveBeenCalledWith('payout-1', 'proof-1', 'req-1');
    expect(mockEnqueue).toHaveBeenCalledWith('payout-2', 'proof-2', undefined);
  });

  it('skips rows claimed by another sweeper', async () => {
    mockPrisma.rewardPayout.findMany.mockResolvedValueOnce([
      {
        id: 'payout-1',
        proofId: 'proof-1',
        requestId: null,
        status: 'PENDING',
        attempts: 0,
      },
    ]);
    mockPrisma.rewardPayout.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.rewardPayout.findMany.mockResolvedValueOnce([]);

    const result = await drainRewardPayouts();

    expect(result.enqueued).toBe(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('reclaims stale PROCESSING rows', async () => {
    mockPrisma.rewardPayout.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'payout-1',
        proofId: 'proof-1',
        status: 'PROCESSING',
        attempts: 1,
        createdAt: new Date('2026-01-01'),
      },
    ]);

    const result = await drainRewardPayouts();

    expect(result.reclaimed).toBe(1);
    expect(mockPrisma.rewardPayout.update).toHaveBeenCalledWith({
      where: { id: 'payout-1' },
      data: {
        status: 'PENDING',
        attempts: 2,
        nextAttemptAt: expect.any(Date),
      },
    });
  });

  it('dead-letters PROCESSING rows after max attempts', async () => {
    mockPrisma.rewardPayout.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'payout-1',
        proofId: 'proof-1',
        status: 'PROCESSING',
        attempts: 3,
        createdAt: new Date('2026-01-01'),
      },
    ]);

    const result = await drainRewardPayouts(20, 3);

    expect(result.deadLettered).toBe(1);
    expect(mockPrisma.rewardPayout.update).toHaveBeenCalledWith({
      where: { id: 'payout-1' },
      data: { status: 'FAILED', lastError: 'Max attempts exceeded (stale PROCESSING)' },
    });
  });

  it('crash recovery: PENDING row from previous crash is picked up', async () => {
    const crashPayout = {
      id: 'payout-crashed',
      proofId: 'proof-crashed',
      requestId: 'req-crashed',
      status: 'PENDING' as const,
      attempts: 0,
      nextAttemptAt: new Date('2026-01-01'),
      createdAt: new Date('2026-01-01'),
    };
    mockPrisma.rewardPayout.findMany.mockResolvedValueOnce([crashPayout]);
    mockPrisma.rewardPayout.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.rewardPayout.findMany.mockResolvedValueOnce([]);

    const result = await drainRewardPayouts();

    expect(result.enqueued).toBe(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      'payout-crashed',
      'proof-crashed',
      'req-crashed',
    );
  });
});
