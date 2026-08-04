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

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    proof: { findUnique: jest.fn(), update: jest.fn() },
    verification: { create: jest.fn() },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import '../../src/workers/verificationWorker';
import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock; update: jest.Mock };
  verification: { create: jest.Mock };
};

const processor = (Worker as unknown as jest.Mock).mock.calls[0][1] as (job: {
  id: string;
  data: { proofId: string };
}) => Promise<void>;

describe('Verification Worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
