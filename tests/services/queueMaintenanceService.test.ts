import { cleanupQueueJobs } from '../../src/services/queueMaintenanceService';

describe('Queue maintenance service', () => {
  it('keeps the newest completed jobs and removes expired failures', async () => {
    const removedJobs = Array.from({ length: 3 }, () => ({
      remove: jest.fn().mockResolvedValue(undefined),
    }));
    const queue = {
      name: 'proof-verification',
      getJobCountByTypes: jest.fn().mockResolvedValue(5),
      getJobs: jest.fn().mockResolvedValue(removedJobs),
      clean: jest.fn().mockResolvedValueOnce(['failed-1']).mockResolvedValueOnce([]),
    };

    const result = await cleanupQueueJobs(queue, {
      completedCount: 2,
      failedAgeSeconds: 3600,
    });

    expect(queue.getJobs).toHaveBeenCalledWith('completed', 0, 2, true);
    expect(removedJobs.every((job) => job.remove.mock.calls.length === 1)).toBe(true);
    expect(queue.clean).toHaveBeenCalledWith(3600000, 1000, 'failed');
    expect(result).toEqual({
      queue: 'proof-verification',
      completedRemoved: 3,
      failedRemoved: 1,
    });
  });

  it('rejects invalid cleanup batch sizes', async () => {
    const queue = {
      name: 'proof-verification',
      getJobCountByTypes: jest.fn(),
      getJobs: jest.fn(),
      clean: jest.fn(),
    };

    await expect(
      cleanupQueueJobs(queue, { completedCount: 2, failedAgeSeconds: 3600 }, 0),
    ).rejects.toThrow('positive integer');
  });
});
