import { Worker, Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { dispatchNotification } from '../services/notificationDispatchService';
import logger from '../utils/logger';
import { redisConnectionManager } from '../utils/redisConnectionManager.js';
import { runWithRequestContext } from '../utils/requestContext.js';
import { getQueueRetentionOptions, QUEUE_NAMES } from './queueRetention.js';

// The queue is created lazily so importing this module never opens a socket;
// the shared connection only connects once a dispatch is enqueued or the
// worker starts.
let queue: Queue<NotificationJobData> | null = null;
let worker: Worker<NotificationJobData> | null = null;
const queueName = QUEUE_NAMES.notificationDispatch;
const retentionOptions = getQueueRetentionOptions(queueName);

interface NotificationJobData {
  notificationId: string;
  outboxId: string;
  requestId?: string;
}

// BullMQ bundles its own ioredis; the cast is purely type-level — it is the
// same shared ioredis client at runtime.
function getConnection(): ConnectionOptions {
  return redisConnectionManager.getClient() as ConnectionOptions;
}

export function getNotificationQueue(): Queue<NotificationJobData> {
  if (!queue) {
    queue = new Queue<NotificationJobData>(queueName, {
      connection: getConnection(),
      defaultJobOptions: retentionOptions,
    });
  }
  return queue;
}

// Enqueues a single BullMQ dispatch job for an already-persisted outbox row.
// The outbox row's id is used as the BullMQ jobId so re-enqueueing the same
// row (e.g. a retried drain sweep) is deduped by BullMQ instead of creating
// a duplicate job. This function intentionally does NOT swallow errors: the
// caller is `drainNotificationOutbox`, which relies on the rejection to
// decide whether to retry the row (with backoff) or move it to
// DEAD_LETTER — a failing Redis connection must not silently drop the
// notification, it must leave the outbox row recoverable.
export async function enqueueNotificationDispatch(
  outboxId: string,
  notificationId: string,
  requestId?: string,
): Promise<void> {
  await getNotificationQueue().add(
    'dispatch',
    {
      notificationId,
      outboxId,
      ...(requestId ? { requestId } : {}),
    },
    {
      jobId: outboxId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      ...retentionOptions,
    },
  );
}

export function startNotificationWorker(): void {
  if (worker) return;
  worker = new Worker<NotificationJobData>(
    queueName,
    async (job) => {
      const { notificationId, requestId } = job.data;
      return runWithRequestContext(requestId, async () => {
        logger.info('Dispatching notification', {
          notificationId,
          ...(requestId ? { requestId } : {}),
        });
        await dispatchNotification(notificationId);
      });
    },
    { connection: getConnection() },
  );

  worker.on('completed', (job) =>
    logger.info('Notification dispatch completed', {
      jobId: job.id,
      ...(job.data.requestId ? { requestId: job.data.requestId } : {}),
    }),
  );
  worker.on('failed', (job, err) =>
    logger.error('Notification dispatch failed', {
      jobId: job?.id,
      ...(job?.data?.requestId ? { requestId: job.data.requestId } : {}),
      err,
    }),
  );
}

export async function shutdownNotificationWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info('Notification dispatch worker shut down');
}

export default startNotificationWorker;
