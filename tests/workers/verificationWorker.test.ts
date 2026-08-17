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
    proof: { findUnique: jest.fn(), update: jest.fn() },
    verification: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../src/models/task', () => ({
  completeTaskIfFull: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../src/workers/rewardWorker', () => ({
  enqueueRewardPayout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import '../../src/workers/verificationWorker';
import prisma from '../../src/utils/prisma';
import { notifyProofStatus } from '../../src/services/notificationService';

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock; update: jest.Mock };
  verification: { create: jest.Mock };
  $transaction: jest.Mock;
};

const processor = (Worker as unknown as jest.Mock).mock.calls[0][1] as (job: {
  id: string;
  data: { proofId: string };
}) => Promise<void>;

describe('Verification Worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
    );
  });

  it('skips proofs that have already reached a final state', async () => {
    mockPrisma.proof.findUnique.mockResolvedValue({
      userId: 'user-1',
      status: 'APPROVED',
    });

    await processor({ id: 'job-1', data: { proofId: 'proof-1' } });

    expect(mockPrisma.proof.update).not.toHaveBeenCalled();
  });

  it('processes pending proofs', async () => {
    mockPrisma.proof.findUnique.mockResolvedValue({
      userId: 'user-1',
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
      data: { status: 'VERIFYING' },
    });
  });

  it('approves valid proofs, checks capacity and enqueues payout', async () => {
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

    const { completeTaskIfFull } = jest.requireMock('../../src/models/task') as {
      completeTaskIfFull: jest.Mock;
    };
    completeTaskIfFull.mockResolvedValue(true);
    const { enqueueRewardPayout } = jest.requireMock(
      '../../src/workers/rewardWorker',
    ) as {
      enqueueRewardPayout: jest.Mock;
    };

    await processor({ id: 'job-1', data: { proofId: 'proof-1' } });

    expect(mockPrisma.proof.update).toHaveBeenCalledWith({
      where: { id: 'proof-1' },
      data: { status: 'APPROVED' },
    });
    expect(completeTaskIfFull).toHaveBeenCalledWith('task-1');
    expect(enqueueRewardPayout).toHaveBeenCalledWith('proof-1');

    // The proof status update, the Verification record and the notification
    // are all committed inside the same interactive transaction so a crash
    // between "approved" and "notified" cannot happen.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(notifyProofStatus).toHaveBeenCalledWith(
      'user-1',
      'proof-1',
      'APPROVED',
      mockPrisma,
    );
  });

  it('rejects invalid proofs inside the same transaction as the notification', async () => {
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
  });

  it('assigns inconclusive proofs to community validators', async () => {
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
  });
});
