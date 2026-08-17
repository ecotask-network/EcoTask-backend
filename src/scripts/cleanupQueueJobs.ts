import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import config from '../config/default.js';
import { cleanupQueueJobs } from '../services/queueMaintenanceService.js';
import {
  getQueueRetentionPolicy,
  QUEUE_NAMES,
  type QueueName,
} from '../workers/queueRetention.js';

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null }) as any;
  const queueNames = Object.values(QUEUE_NAMES);
  const queues = queueNames.map((name) => new Queue(name, { connection }));

  try {
    const results = [];
    for (const queue of queues) {
      results.push(
        await cleanupQueueJobs(queue, getQueueRetentionPolicy(queue.name as QueueName)),
      );
    }
    console.table(results);
  } finally {
    await Promise.all(queues.map((queue) => queue.close()));
    await connection.quit();
  }
}

main().catch((err) => {
  console.error('Queue cleanup failed', err);
  process.exitCode = 1;
});
