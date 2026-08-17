import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import config from '../config/default';
import { dispatchNotification } from '../services/notificationDispatchService';
import logger from '../utils/logger';

// Connections are created lazily so importing this module never opens a
// socket; it only connects once a dispatch is enqueued or the worker starts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connection: any = null;
let queue: Queue | null = null;
let worker: Worker | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getConnection(): any {
  if (!connection) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null }) as any;
    connection.on('error', () => {
      // Outbound delivery is best-effort; a failing Redis connection must not crash the API.
    });
  }
  return connection;
}

export function getNotificationQueue(): Queue {
  if (!queue) {
    queue = new Queue('notification-dispatch', { connection: getConnection() });
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
): Promise<void> {
  await getNotificationQueue().add(
    'dispatch',
    { notificationId, outboxId },
    {
      jobId: outboxId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
}

export function startNotificationWorker(): void {
  if (worker) return;
  worker = new Worker(
    'notification-dispatch',
    async (job) => {
      const { notificationId } = job.data;
      logger.info('Dispatching notification', { notificationId });
      await dispatchNotification(notificationId);
    },
    { connection: getConnection() },
  );

  worker.on('completed', (job) =>
    logger.info('Notification dispatch completed', { jobId: job.id }),
  );
  worker.on('failed', (job, err) =>
    logger.error('Notification dispatch failed', { jobId: job?.id, err }),
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
  if (connection) {
    await connection.quit();
    connection = null;
  }
  logger.info('Notification dispatch worker shut down');
}

export default startNotificationWorker;
