import { Worker } from 'bullmq';

jest.mock('bullmq', () => ({
  Worker: jest.fn(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Queue: jest.fn(() => ({
    add: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('ioredis', () => {
  class MockRedis {
    quit() {
      return Promise.resolve();
    }
  }
  return { __esModule: true, default: MockRedis };
});

jest.mock('../../src/config/default', () => ({
  redis: { url: 'redis://localhost:6379' },
}));

jest.mock('../../src/services/stellarService', () => ({
  submitReward: jest.fn(),
}));

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    proof: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import '../../src/workers/rewardWorker';
import prisma from '../../src/utils/prisma';
import { submitReward } from '../../src/services/stellarService';

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock; update: jest.Mock };
};
const mockSubmitReward = submitReward as jest.Mock;

const processor = (Worker as unknown as jest.Mock).mock.calls[0][1] as (job: {
  id: string;
  data: { proofId: string };
}) => Promise<void>;

function approvedProof(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proof-1',
    taskId: 'task-1',
    status: 'APPROVED',
    rewardedAt: null,
    user: { wallet: 'GC...' },
    task: { rewardAmount: 50, rewardToken: 'ECO' },
    ...overrides,
  };
}

describe('Reward Worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips payout for an already rewarded proof', async () => {
    mockPrisma.proof.findUnique.mockResolvedValue(
      approvedProof({ rewardedAt: new Date('2026-08-01') }),
    );

    await processor({ id: 'job-1', data: { proofId: 'proof-1' } });

    expect(mockSubmitReward).not.toHaveBeenCalled();
    expect(mockPrisma.proof.update).not.toHaveBeenCalled();
  });

  it('refuses to pay out for a proof that is not approved', async () => {
    mockPrisma.proof.findUnique.mockResolvedValue(approvedProof({ status: 'PENDING' }));

    await expect(
      processor({ id: 'job-1', data: { proofId: 'proof-1' } }),
    ).rejects.toThrow(/not approved|state 'PENDING'/);

    expect(mockSubmitReward).not.toHaveBeenCalled();
  });

  it('pays out once and records the reward timestamp', async () => {
    mockPrisma.proof.findUnique.mockResolvedValue(approvedProof());
    mockSubmitReward.mockResolvedValue('tx-hash-1');
    mockPrisma.proof.update.mockResolvedValue({});

    await processor({ id: 'job-1', data: { proofId: 'proof-1' } });

    expect(mockSubmitReward).toHaveBeenCalledWith({
      userWallet: 'GC...',
      taskId: 'task-1',
      amount: 50,
      assetCode: 'ECO',
    });
    expect(mockPrisma.proof.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { rewardedAt: expect.any(Date) } }),
    );
  });
});
