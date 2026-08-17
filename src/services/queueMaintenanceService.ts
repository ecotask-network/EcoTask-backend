import type { Queue } from 'bullmq';
import type { QueueRetentionPolicy } from '../workers/queueRetention.js';

const DEFAULT_CLEANUP_BATCH_SIZE = 1000;

type CleanableQueue = Pick<Queue, 'name' | 'clean' | 'getJobCountByTypes' | 'getJobs'>;

export interface QueueCleanupResult {
  queue: string;
  completedRemoved: number;
  failedRemoved: number;
}

async function trimCompletedJobs(
  queue: CleanableQueue,
  retainedCount: number,
  batchSize: number,
): Promise<number> {
  const completedCount = await queue.getJobCountByTypes('completed');
  let remaining = Math.max(completedCount - retainedCount, 0);
  let removed = 0;

  while (remaining > 0) {
    const limit = Math.min(remaining, batchSize);
    const jobs = await queue.getJobs('completed', 0, limit - 1, true);
    if (jobs.length === 0) break;

    await Promise.all(jobs.map((job) => job.remove()));
    removed += jobs.length;
    remaining -= jobs.length;

    if (jobs.length < limit) break;
  }

  return removed;
}

async function removeExpiredFailedJobs(
  queue: CleanableQueue,
  failedAgeSeconds: number,
  batchSize: number,
): Promise<number> {
  const graceMs = failedAgeSeconds * 1000;
  let removed = 0;

  while (true) {
    const jobIds = await queue.clean(graceMs, batchSize, 'failed');
    removed += jobIds.length;
    if (jobIds.length < batchSize) break;
  }

  return removed;
}

export async function cleanupQueueJobs(
  queue: CleanableQueue,
  policy: QueueRetentionPolicy,
  batchSize = DEFAULT_CLEANUP_BATCH_SIZE,
): Promise<QueueCleanupResult> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Queue cleanup batch size must be a positive integer');
  }

  const completedRemoved = await trimCompletedJobs(
    queue,
    policy.completedCount,
    batchSize,
  );
  const failedRemoved = await removeExpiredFailedJobs(
    queue,
    policy.failedAgeSeconds,
    batchSize,
  );

  return {
    queue: queue.name,
    completedRemoved,
    failedRemoved,
  };
}
