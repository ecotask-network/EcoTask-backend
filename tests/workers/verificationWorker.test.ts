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

jest.mock('../../src/services/verificationService', () => ({
  autoVerify: jest.fn(),
}));

jest.mock('../../src/services/notificationService', () => ({
  notifyProofStatus: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/validatorService', () => ({
  assignValidators: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    proof: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    verification: { create: jest.fn() },
    rewardPayout: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../src/models/task', () => ({
  claimCompletionSlot: jest
    .fn()
    .mockResolvedValue({ claimed: true, taskCompleted: false }),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import {
  enqueueVerification,
  verificationQueue,
} from '../../src/workers/verificationWorker';
import prisma from '../../src/utils/prisma';
import { notifyProofStatus } from '../../src/services/notificationService';

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
  verification: { create: jest.Mock };
  rewardPayout: { create: jest.Mock };
  $transaction: jest.Mock;
};

const processor = (Worker as unknown as jest.Mock).mock.calls[0][1] as (job: {
  id: string;
  data: { proofId: string; requestId?: string };
}) => Promise<void>;

describe('Verification Worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => {
        const txWithQueryRaw = {
          ...mockPrisma,
          $queryRaw: jest.fn().mockResolvedValue([{ status: 'VERIFYING', task_id: 'task-1', user_id: 'user-1' }]),
        } as unknown as typeof mockPrisma;
        return fn(txWithQueryRaw);
      },
    );
  });

  it('retains completed and failed jobs without changing retry behavior', async () => {
    const addSpy = (verificationQueue as unknown as { add: jest.Mock }).add;

    await enqueueVerification('proof-1');

    expect(addSpy).toHaveBeenCalledWith(
      'verify',
      { proofId: 'proof-1' },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 604800 },
      },
    );
  });

  it('stores the originating request ID in the verification job', async () => {
    const addSpy = (verificationQueue as unknown as { add: jest.Mock }).add;

    await enqueueVerification('proof-1', 'request-1');

    expect(addSpy).toHaveBeenCalledWith(
      'verify',
      { proofId: 'proof-1', requestId: 'request-1' },
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('skips proofs that have already reached a final state', async () => {
    mockPrisma.proof.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.proof.findUnique.mockResolvedValue({
      status: 'APPROVED',
    });

    await processor({
      id: 'job-1',
      data: { proofId: 'proof-1', requestId: 'request-1' },
    });

    expect(mockPrisma.proof.update).not.toHaveBeenCalled();
  });

  it('claims pending proof via atomic updateMany', async () => {
    mockPrisma.proof.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.proof.findUnique.mockResolvedValue({
      userId: 'user-1',
      taskId: 'task-1',
      status: 'PENDING',
    });
    mockPrisma.proof.update.mockResolvedValue({});
    const { autoVerify } = jest.requireMock('../../src/services/verificationService') as {
      autoVerify: jest.Mock;
    };
    autoVerify.mockResolvedValue({ verdict: 'rejected', confidence: 0.1, notes: 'gps' });

    await processor({ id: 'job-1', data: { proofId: 'proof-1' } });

    expect(mockPrisma.proof.updateMany).toHaveBeenCalledWith({
      where: { id: 'proof-1', status: 'PENDING' },
      data: { status: 'VERIFYING' },
    });
  });

  it('approves valid proofs, checks capacity and creates payout outbox row', async () => {
    mockPrisma.proof.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.proof.findUnique.mockResolvedValue({
      userId: 'user-1',
      taskId: 'task-1',
      status: 'PENDING',
    });
    mockPrisma.proof.update.mockResolvedValue({});
    const { autoVerify } = jest.requireMock('../../src/services/verificationService') as {
      autoVerify: jest.Mock;
    };
    autoVerify.mockResolvedValue({ verdict: 'approved', confidence: 0.9, notes: 'ok' });

    const { claimCompletionSlot } = jest.requireMock('../../src/models/task') as {
      claimCompletionSlot: jest.Mock;
    };
    claimCompletionSlot.mockResolvedValue({ claimed: true, taskCompleted: true });
    const { notifyProofStatus } = jest.requireMock(
      '../../src/services/notificationService',
    ) as {
      notifyProofStatus: jest.Mock;
    };
    const mockedLogger = jest.requireMock('../../src/utils/logger').default as {
      info: jest.Mock;
    };

    await processor({
      id: 'job-1',
      data: { proofId: 'proof-1', requestId: 'request-1' },
    });

    expect(mockPrisma.proof.update).toHaveBeenCalledWith({
      where: { id: 'proof-1' },
      data: { status: 'APPROVED' },
    });
    expect(claimCompletionSlot).toHaveBeenCalledWith(mockPrisma, 'task-1');

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(notifyProofStatus).toHaveBeenCalledWith(
      'user-1',
      'proof-1',
      'APPROVED',
      mockPrisma,
      'request-1',
    );
    expect(mockPrisma.rewardPayout.create).toHaveBeenCalledWith({
      data: { proofId: 'proof-1', requestId: 'request-1' },
    });
    expect(mockedLogger.info).toHaveBeenCalledWith('Processing proof verification', {
      proofId: 'proof-1',
      requestId: 'request-1',
    });
  });

  it('rejects invalid proofs inside the same transaction as the notification', async () => {
    mockPrisma.proof.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.proof.findUnique.mockResolvedValue({
      userId: 'user-1',
      taskId: 'task-1',
      status: 'PENDING',
    });
    mockPrisma.proof.update.mockResolvedValue({});
    const { autoVerify } = jest.requireMock('../../src/services/verificationService') as {
      autoVerify: jest.Mock;
    };
    autoVerify.mockResolvedValue({ verdict: 'rejected', confidence: 0.1, notes: 'gps' });

    await processor({ id: 'job-1', data: { proofId: 'proof-1' } });

    expect(mockPrisma.proof.update).toHaveBeenCalledWith({
      where: { id: 'proof-1' },
      data: { status: 'REJECTED' },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(notifyProofStatus).toHaveBeenCalledWith(
      'user-1',
      'proof-1',
      'REJECTED',
      mockPrisma,
    );
    expect(mockPrisma.rewardPayout.create).not.toHaveBeenCalled();
  });

  it('assigns inconclusive proofs to community validators', async () => {
    mockPrisma.proof.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.proof.findUnique.mockResolvedValue({
      userId: 'user-1',
      taskId: 'task-1',
      status: 'PENDING',
    });
    mockPrisma.proof.update.mockResolvedValue({});
    const { autoVerify } = jest.requireMock('../../src/services/verificationService') as {
      autoVerify: jest.Mock;
    };
    autoVerify.mockResolvedValue({ verdict: 'inconclusive', confidence: 0.5, notes: '' });
    const { assignValidators } = jest.requireMock(
      '../../src/services/validatorService',
    ) as {
      assignValidators: jest.Mock;
    };
    assignValidators.mockResolvedValue(3);

    await processor({ id: 'job-1', data: { proofId: 'proof-1' } });

    expect(assignValidators).toHaveBeenCalledWith('proof-1');
    expect(mockPrisma.proof.update).not.toHaveBeenCalledWith({
      where: { id: 'proof-1' },
      data: { status: 'APPROVED' },
    });
    expect(mockPrisma.rewardPayout.create).not.toHaveBeenCalled();
  });

  it('concurrent verification jobs for the same proof are idempotent', async () => {
    let claimCount = 0;
    mockPrisma.proof.updateMany.mockImplementation(async () => {
      claimCount++;
      return { count: claimCount === 1 ? 1 : 0 };
    });
    mockPrisma.proof.findUnique.mockResolvedValue({
      userId: 'user-1',
      taskId: 'task-1',
      status: 'PENDING',
    });
    mockPrisma.proof.update.mockResolvedValue({});
    const { autoVerify } = jest.requireMock('../../src/services/verificationService') as {
      autoVerify: jest.Mock;
    };
    autoVerify.mockResolvedValue({ verdict: 'approved', confidence: 0.9, notes: 'ok' });
    const { claimCompletionSlot } = jest.requireMock('../../src/models/task') as {
      claimCompletionSlot: jest.Mock;
    };
    claimCompletionSlot.mockResolvedValue({ claimed: true, taskCompleted: false });

    const job1 = processor({
      id: 'job-1',
      data: { proofId: 'proof-1' },
    });
    const job2 = processor({
      id: 'job-2',
      data: { proofId: 'proof-1' },
    });

    await Promise.all([job1, job2]);

    expect(autoVerify).toHaveBeenCalledTimes(1);
    expect(mockPrisma.rewardPayout.create).toHaveBeenCalledTimes(1);
  });
});
