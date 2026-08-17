import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import config from '../config/default.js';
import { getQueueRetentionOptions } from '../workers/queueRetention.js';

const queueName = `queue-retention-load-test-${process.pid}-${Date.now()}`;
const jobCount = parseInt(process.env.QUEUE_RETENTION_LOAD_JOBS || '2000', 10);
const batchSize = parseInt(process.env.QUEUE_RETENTION_LOAD_BATCH_SIZE || '250', 10);
const completedCount = parseInt(
  process.env.QUEUE_RETENTION_LOAD_COMPLETED_COUNT || '100',
  10,
);
const failedAgeSeconds = parseInt(
  process.env.QUEUE_RETENTION_LOAD_FAILED_TTL_SECONDS || '1',
  10,
);

interface Snapshot {
  jobsProcessed: number;
  keys: number;
  memoryBytes: number;
  eventEntries: number;
  completed: number;
  failed: number;
}

async function waitForBatch(worker: Worker, expectedJobs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = 0;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedJobs} jobs to settle`));
    }, 30000);

    const onSettled = () => {
      settled += 1;
      if (settled === expectedJobs) {
        cleanup();
        resolve();
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off('completed', onSettled);
      worker.off('failed', onSettled);
      worker.off('error', onError);
    };

    worker.on('completed', onSettled);
    worker.on('failed', onSettled);
    worker.on('error', onError);
  });
}

async function getQueueKeys(connection: IORedis, pattern: string): Promise<string[]> {
  let cursor = '0';
  const keys: string[] = [];

  do {
    const [nextCursor, found] = await connection.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      1000,
    );
    cursor = nextCursor;
    keys.push(...found);
  } while (cursor !== '0');

  return keys;
}

async function takeSnapshot(
  queue: Queue,
  connection: IORedis,
  jobsProcessed: number,
): Promise<Snapshot> {
  const counts = await queue.getJobCounts('completed', 'failed');
  const keys = await getQueueKeys(connection, `bull:${queueName}:*`);
  const memory = await Promise.all(
    keys.map(async (key) => Number((await connection.memory('USAGE', key)) || 0)),
  );

  return {
    jobsProcessed,
    keys: keys.length,
    memoryBytes: memory.reduce((total, bytes) => total + bytes, 0),
    eventEntries: await connection.xlen(queue.toKey('events')),
    completed: counts.completed,
    failed: counts.failed,
  };
}

function assertStable(snapshots: Snapshot[]): void {
  const steadyState = snapshots.slice(2);
  const keyCounts = steadyState.map((snapshot) => snapshot.keys);
  const memorySizes = steadyState.map((snapshot) => snapshot.memoryBytes);
  const keySpread = Math.max(...keyCounts) - Math.min(...keyCounts);
  const minMemory = Math.min(...memorySizes);
  const maxMemory = Math.max(...memorySizes);

  if (keySpread > 10) {
    throw new Error(`Queue key count did not stabilize; spread was ${keySpread}`);
  }
  if (maxMemory > minMemory * 1.5 + 64 * 1024) {
    throw new Error(
      `Queue memory did not stabilize; range was ${minMemory} to ${maxMemory} bytes`,
    );
  }
  if (snapshots.some((snapshot) => snapshot.completed > completedCount)) {
    throw new Error('Completed job retention exceeded the configured count');
  }
  const failedCount = Math.ceil(batchSize / 2);
  if (snapshots.some((snapshot) => snapshot.failed > failedCount)) {
    throw new Error('Expired failed jobs were not removed after their configured TTL');
  }
}

async function main(): Promise<void> {
  if (jobCount < batchSize * 4 || jobCount % batchSize !== 0) {
    throw new Error('Load job count must be divisible into at least four full batches');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null }) as any;
  const retentionOptions = {
    ...getQueueRetentionOptions('proof-verification'),
    removeOnComplete: { count: completedCount },
    removeOnFail: { age: failedAgeSeconds },
  };
  const queue = new Queue(queueName, {
    connection,
    defaultJobOptions: retentionOptions,
    streams: { events: { maxLen: 100 } },
  });
  const worker = new Worker(
    queueName,
    async (job) => {
      if (job.data.shouldFail) throw new Error('Expected load test failure');
    },
    { connection, concurrency: 50 },
  );
  const snapshots: Snapshot[] = [];

  try {
    for (let offset = 0; offset < jobCount; offset += batchSize) {
      if (offset > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, failedAgeSeconds * 1000 + 100),
        );
      }

      const settled = waitForBatch(worker, batchSize);
      await queue.addBulk(
        Array.from({ length: batchSize }, (_, index) => ({
          name: 'retention-check',
          data: { shouldFail: index % 2 === 0 },
          opts: retentionOptions,
        })),
      );
      await settled;
      snapshots.push(await takeSnapshot(queue, connection, offset + batchSize));
    }

    console.table(snapshots);
    assertStable(snapshots);
    console.log(`Queue retention remained bounded across ${jobCount} jobs`);
  } finally {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  }
}

main().catch((err) => {
  console.error('Queue retention load test failed', err);
  process.exitCode = 1;
});
