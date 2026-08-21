import prisma from '../../src/utils/prisma';
import { claimCompletionSlot } from '../../src/models/task';

describe('claimCompletionSlot: atomic capacity enforcement (real DB)', () => {
  let taskId: string;

  beforeEach(async () => {
    const task = await prisma.task.create({
      data: {
        title: 'Concurrency test task',
        type: 'cleanup',
        rewardAmountMicros: 1000000n,
        lat: 0,
        lng: 0,
        maxCompletions: 5,
      },
    });
    taskId = task.id;
  });

  afterEach(async () => {
    await prisma.task.delete({ where: { id: taskId } }).catch(() => {});
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('never exceeds maxCompletions under 6 simultaneous approvals, and completes exactly once', async () => {
    const attempts = Array.from({ length: 6 }, () =>
      prisma.$transaction((tx) => claimCompletionSlot(tx, taskId)),
    );

    const results = await Promise.all(attempts);

    const claimed = results.filter((r) => r.claimed);
    const completions = results.filter((r) => r.claimed && r.taskCompleted);

    expect(claimed.length).toBe(5);
    expect(completions.length).toBe(1);

    const finalTask = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(finalTask.completedCount).toBe(5);
    expect(finalTask.status).toBe('COMPLETED');
  });
});