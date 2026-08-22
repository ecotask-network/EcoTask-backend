import { Queue, type ConnectionOptions } from 'bullmq';
import { redisConnectionManager } from '../utils/redisConnectionManager.js';
import { QUEUE_NAMES, type QueueName } from '../workers/queueRetention.js';

/**
 * Admin/ops-facing read surface for the BullMQ queues that back the
 * verification and reward-payout pipelines. This is the worker-side
 * companion to the notification outbox dead-letter view: a stuck or
 * exhausted job in these queues is observable (and recoverable) instead
 * of only visible in logs.
 *
 * Only these two queues are managed here; the notification-dispatch queue
 * already has an outbox-based dead-letter surface
 * (see notificationOutboxService.listDeadLetteredNotifications).
 */
export const ADMIN_QUEUE_NAMES: readonly QueueName[] = [
  QUEUE_NAMES.proofVerification,
  QUEUE_NAMES.rewardPayout,
];

// Queues are created lazily so importing this module never opens a socket;
// the admin surface only connects when it is actually used. Connections are
// shared with the rest of the process via RedisConnectionManager so the admin
// surface never opens (or closes) its own Redis socket.
const queues = new Map<string, Queue>();

function getQueue(queueName: string): Queue {
  let queue = queues.get(queueName);
  if (!queue) {
    queue = new Queue(queueName, {
      connection: redisConnectionManager.getClient() as ConnectionOptions,
    });
    queues.set(queueName, queue);
  }
  return queue;
}

export function isAdminQueueName(value: string): value is QueueName {
  return (ADMIN_QUEUE_NAMES as readonly string[]).includes(value);
}

/**
 * Closes all lazily-created admin BullMQ queues and clears the cache. The
 * shared Redis connection is intentionally left alone — it is owned by
 * RedisConnectionManager and closed once during app shutdown.
 * Safe to call repeatedly; used by tests to isolate state and by the app on
 * graceful shutdown.
 */
export async function closeAdminQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}

export interface QueueCounts {
  queue: QueueName;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export async function getQueueCounts(queueName: QueueName): Promise<QueueCounts> {
  const counts = await getQueue(queueName).getJobCounts(
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed',
    'paused',
  );
  return {
    queue: queueName,
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    paused: counts.paused ?? 0,
  };
}

export interface FailedJobView {
  id: string;
  name: string;
  data: unknown;
  attemptsMade: number;
  failedReason: string | null;
  stacktrace: string[];
  timestamp: number | null;
  finishedOn: number | null;
}

export interface FailedJobsPage {
  items: FailedJobView[];
  total: number;
}

/**
 * Lists failed jobs for a queue, newest first, with the data operators need
 * to decide whether to retry: attempts made, failure reason, stacktrace and
 * timestamps. The total comes from the same Redis call used for the counts
 * endpoint so pagination stays consistent with the overview.
 */
export async function listFailedJobs(
  queueName: QueueName,
  limit: number,
  offset: number,
): Promise<FailedJobsPage> {
  const queue = getQueue(queueName);
  const [jobs, counts] = await Promise.all([
    queue.getFailed(offset, offset + limit - 1),
    queue.getJobCounts('failed'),
  ]);

  return {
    items: jobs.map((job) => ({
      id: job.id ?? '',
      name: job.name,
      data: job.data,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason ?? null,
      stacktrace: job.stacktrace ?? [],
      timestamp: job.timestamp ?? null,
      finishedOn: job.finishedOn ?? null,
    })),
    total: counts.failed ?? 0,
  };
}

export class QueueAdminError extends Error {}
export class JobNotFoundError extends QueueAdminError {}
export class JobNotFailedError extends QueueAdminError {}

/**
 * Retries a single failed job, moving it back to the waiting list so the
 * worker picks it up again. Only jobs currently in the failed state are
 * eligible — a job that already left the failed state (e.g. via a
 * concurrent retry) is rejected instead of being double-processed.
 */
export async function retryFailedJob(
  queueName: QueueName,
  jobId: string,
): Promise<{ queue: QueueName; jobId: string }> {
  const job = await getQueue(queueName).getJob(jobId);
  if (!job) {
    throw new JobNotFoundError(`Job ${jobId} not found in queue ${queueName}`);
  }
  if (!(await job.isFailed())) {
    throw new JobNotFailedError(`Job ${jobId} is not in the failed state`);
  }
  await job.retry();
  return { queue: queueName, jobId };
}
