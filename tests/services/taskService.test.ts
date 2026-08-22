import { expireOverdueTasks } from '../../src/services/taskService';

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    task: { updateMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    proof: { count: jest.fn() },
    taskClaim: { updateMany: jest.fn() },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  task: { updateMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  proof: { count: jest.Mock };
  taskClaim: { updateMany: jest.Mock };
};

describe('Task service: expiry sweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks overdue ACTIVE tasks EXPIRED', async () => {
    mockPrisma.task.updateMany.mockResolvedValue({ count: 3 });
    mockPrisma.taskClaim.updateMany.mockResolvedValue({ count: 0 });

    const result = await expireOverdueTasks();

    expect(result).toEqual({ tasksExpired: 3, claimsExpired: 0 });
    expect(mockPrisma.task.updateMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', expiresAt: { lt: expect.any(Date) } },
      data: { status: 'EXPIRED' },
    });
  });

  it('expires overdue active claims', async () => {
    mockPrisma.task.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.taskClaim.updateMany.mockResolvedValue({ count: 4 });

    const result = await expireOverdueTasks();

    expect(result).toEqual({ tasksExpired: 0, claimsExpired: 4 });
    expect(mockPrisma.taskClaim.updateMany).toHaveBeenCalledWith({
      where: { status: 'active', expiresAt: { lt: expect.any(Date) } },
      data: { status: 'expired' },
    });
  });

  it('returns zeros when nothing is overdue', async () => {
    mockPrisma.task.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.taskClaim.updateMany.mockResolvedValue({ count: 0 });

    const result = await expireOverdueTasks();

    expect(result).toEqual({ tasksExpired: 0, claimsExpired: 0 });
  });
});

jest.mock('../../src/services/proofFinalizationService', () => ({
  finalizeProofStatus: jest.fn(),
}));

import { recoverOrphanedProofs } from '../../src/services/taskService';
import { finalizeProofStatus } from '../../src/services/proofFinalizationService';

const mockFinalizeProofStatus = finalizeProofStatus as jest.Mock;

describe('Task service: orphaned proofs recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('finds orphaned proofs and rejects them', async () => {
    (mockPrisma.proof as any).findMany = jest.fn().mockResolvedValue([
      { id: 'proof-1' },
      { id: 'proof-2' },
    ]);
    mockFinalizeProofStatus.mockResolvedValue({
      finalStatus: 'REJECTED',
      taskCompleted: false,
      proofRecord: { userId: 'u1', taskId: 't1' },
    });

    const recovered = await recoverOrphanedProofs();

    expect(recovered).toBe(2);
    expect((mockPrisma.proof as any).findMany).toHaveBeenCalledWith({
      where: {
        status: 'PENDING',
        createdAt: { lt: expect.any(Date) },
      },
      select: { id: true },
    });

    expect(mockFinalizeProofStatus).toHaveBeenCalledTimes(2);
    expect(mockFinalizeProofStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        proofId: 'proof-1',
        verifierId: 'system-sweeper',
        verdict: 'rejected',
        expectedStatuses: ['PENDING'],
      })
    );
  });
});

