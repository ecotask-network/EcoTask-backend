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
      where: { status: 'ACTIVE', expiresAt: { lt: expect.any(Date) } },
      data: { status: 'EXPIRED' },
    });
  });

  it('returns zeros when nothing is overdue', async () => {
    mockPrisma.task.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.taskClaim.updateMany.mockResolvedValue({ count: 0 });

    const result = await expireOverdueTasks();

    expect(result).toEqual({ tasksExpired: 0, claimsExpired: 0 });
  });
});
