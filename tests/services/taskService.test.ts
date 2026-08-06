import { expireOverdueTasks } from '../../src/services/taskService';
import { completeTaskIfFull } from '../../src/models/task';

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

describe('Task model: capacity completion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('completes a task once approved proofs reach maxCompletions', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      id: 'task-1',
      status: 'ACTIVE',
      maxCompletions: 2,
    });
    mockPrisma.proof.count.mockResolvedValue(2);

    const completed = await completeTaskIfFull('task-1');

    expect(completed).toBe(true);
    expect(mockPrisma.task.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: { status: 'COMPLETED' },
    });
  });

  it('leaves the task ACTIVE below capacity', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      id: 'task-1',
      status: 'ACTIVE',
      maxCompletions: 5,
    });
    mockPrisma.proof.count.mockResolvedValue(2);

    const completed = await completeTaskIfFull('task-1');

    expect(completed).toBe(false);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  it('does nothing for tasks without a capacity limit', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      id: 'task-1',
      status: 'ACTIVE',
      maxCompletions: null,
    });
    mockPrisma.proof.count.mockResolvedValue(100);

    const completed = await completeTaskIfFull('task-1');

    expect(completed).toBe(false);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  it('does nothing for tasks that are not ACTIVE', async () => {
    mockPrisma.task.findUnique.mockResolvedValue({
      id: 'task-1',
      status: 'COMPLETED',
      maxCompletions: 2,
    });

    const completed = await completeTaskIfFull('task-1');

    expect(completed).toBe(false);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });
});
