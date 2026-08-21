import { Queue, Worker } from 'bullmq';

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
    rewardPayout: { updateMany: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { enqueueRewardPayout, startRewardWorker } from '../../src/workers/rewardWorker';
import prisma from '../../src/utils/prisma';
import { submitReward } from '../../src/services/stellarService';

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock; update: jest.Mock };
  rewardPayout: { updateMany: jest.Mock; update: jest.Mock };
  $transaction: jest.Mock;
};
const mockSubmitReward = submitReward as jest.Mock;

let processor: (job: {
  id: string;
  data: { payoutId: string; proofId: string; requestId?: string };
}) => Promise<void>;

beforeAll(() => {
  startRewardWorker();
  processor = (Worker as unknown as jest.Mock).mock.calls[0][1];
});

function approvedProof(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proof-1',
    taskId: 'task-1',
    status: 'APPROVED',
    rewardedAt: null,
    user: { wallet: 'GC...' },
    task: { rewardAmountMicros: 500000000n, rewardToken: 'ECO' },
    ...overrides,
  };
}

describe('Reward Worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
    );
  });

  it('enqueues payout job with payoutId as jobId for dedup', async () => {
    await enqueueRewardPayout('payout-1', 'proof-1', 'request-1');

    const queue = (Queue as unknown as jest.Mock).mock.results[0].value as {
      add: jest.Mock;
    };

    expect(queue.add).toHaveBeenCalledWith(
      'payout',
      { payoutId: 'payout-1', proofId: 'proof-1', requestId: 'request-1' },
      {
        jobId: 'payout-1',
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 604800 },
      },
    );
  });

  it('skips payout when another worker already claimed it', async () => {
    mockPrisma.rewardPayout.updateMany.mockResolvedValue({ count: 0 });

    await processor({
      id: 'job-1',
      data: { payoutId: 'payout-1', proofId: 'proof-1' },
    });

    expect(mockSubmitReward).not.toHaveBeenCalled();
    expect(mockPrisma.proof.findUnique).not.toHaveBeenCalled();
  });

  it('refuses to pay out for a proof that is not approved', async () => {
    mockPrisma.rewardPayout.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.proof.findUnique.mockResolvedValue(approvedProof({ status: 'PENDING' }));

    await expect(
      processor({ id: 'job-1', data: { payoutId: 'payout-1', proofId: 'proof-1' } }),
    ).rejects.toThrow(/not approved|state 'PENDING'/);

    expect(mockSubmitReward).not.toHaveBeenCalled();
    expect(mockPrisma.rewardPayout.update).toHaveBeenCalledWith({
      where: { id: 'payout-1' },
      data: { status: 'FAILED', lastError: expect.any(String) },
    });
  });

  it('pays out once and marks payout PAID with txHash', async () => {
    mockPrisma.rewardPayout.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.proof.findUnique.mockResolvedValue(approvedProof());
    mockSubmitReward.mockResolvedValue('tx-hash-1');

    await processor({
      id: 'job-1',
      data: { payoutId: 'payout-1', proofId: 'proof-1', requestId: 'request-1' },
    });

    expect(mockSubmitReward).toHaveBeenCalledWith({
      userWallet: 'GC...',
      taskId: 'task-1',
      amount: '500000000',
      assetCode: 'ECO',
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.rewardPayout.update).toHaveBeenCalledWith({
      where: { id: 'payout-1' },
      data: { status: 'PAID', txHash: 'tx-hash-1' },
    });
    expect(mockPrisma.proof.update).toHaveBeenCalledWith({
      where: { id: 'proof-1' },
      data: { rewardedAt: expect.any(Date) },
    });
  });

  it('marks payout FAILED on Stellar submission error', async () => {
    mockPrisma.rewardPayout.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.proof.findUnique.mockResolvedValue(approvedProof());
    mockSubmitReward.mockRejectedValue(new Error('Stellar error'));

    await expect(
      processor({
        id: 'job-1',
        data: { payoutId: 'payout-1', proofId: 'proof-1' },
      }),
    ).rejects.toThrow('Stellar error');

    expect(mockPrisma.rewardPayout.update).toHaveBeenCalledWith({
      where: { id: 'payout-1' },
      data: {
        status: 'FAILED',
        lastError: 'Stellar error',
        attempts: { increment: 1 },
      },
    });
  });

  it('concurrent jobs for the same payoutId result in exactly one payment', async () => {
    let claimCount = 0;
    mockPrisma.rewardPayout.updateMany.mockImplementation(async () => {
      claimCount++;
      return { count: claimCount === 1 ? 1 : 0 };
    });
    mockPrisma.proof.findUnique.mockResolvedValue(approvedProof());
    mockSubmitReward.mockResolvedValue('tx-hash-1');

    const job1 = processor({
      id: 'job-1',
      data: { payoutId: 'payout-1', proofId: 'proof-1' },
    });
    const job2 = processor({
      id: 'job-2',
      data: { payoutId: 'payout-1', proofId: 'proof-1' },
    });

    await Promise.all([job1, job2]);

    expect(mockSubmitReward).toHaveBeenCalledTimes(1);
  });
});
