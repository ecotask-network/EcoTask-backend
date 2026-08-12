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

export async function enqueueNotificationDispatch(notificationId: string): Promise<void> {
  try {
    await getNotificationQueue().add(
      'dispatch',
      { notificationId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  } catch (err) {
    logger.error('Failed to enqueue notification dispatch', { notificationId, err });
  }
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
