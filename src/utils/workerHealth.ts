import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import config from '../config/default';

interface WorkerStatus {
  name: string;
  alive: boolean;
  lastSeen: Date;
}

interface QueueMetrics {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

interface HealthCheckResult {
  status: 'ok' | 'degraded';
  workers: Record<string, WorkerStatus>;
  queues: Record<string, QueueMetrics>;
}

// Worker registry
const workerRegistry = new Map<string, WorkerStatus>();

// Cache for queue metrics
const metricsCache = new Map<string, { data: QueueMetrics; timestamp: number }>();
const CACHE_TTL_MS = 5000; // Cache metrics for 5 seconds

// Queue thresholds for readiness
const QUEUE_THRESHOLDS = {
  'proof-verification': { maxBacklog: 100, maxStalled: 50 },
  'reward-payout': { maxBacklog: 50, maxStalled: 25 },
  'notification-dispatch': { maxBacklog: 200, maxStalled: 100 },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getConnection(): any {
  return new IORedis(config.redis.url, { maxRetriesPerRequest: null }) as any;
}

export function registerWorker(name: string): void {
  workerRegistry.set(name, {
    name,
    alive: true,
    lastSeen: new Date(),
  });
}

export function unregisterWorker(name: string): void {
  workerRegistry.set(name, {
    name,
    alive: false,
    lastSeen: new Date(),
  });
}

export function getWorkerStatus(name: string): WorkerStatus | undefined {
  return workerRegistry.get(name);
}

export function getAllWorkerStatuses(): Record<string, WorkerStatus> {
  return Object.fromEntries(workerRegistry);
}

async function getQueueMetrics(queueName: string): Promise<QueueMetrics> {
  // Check cache first
  const cached = metricsCache.get(queueName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const connection = getConnection();
  const queue = new Queue(queueName, { connection });

  try {
    const counts = await queue.getJobCounts();
    const metrics: QueueMetrics = {
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
    };

    // Cache the metrics
    metricsCache.set(queueName, { data: metrics, timestamp: Date.now() });

    await queue.close();
    await connection.quit();

    return metrics;
  } catch (error) {
    await queue.close().catch(() => {});
    await connection.quit().catch(() => {});
    throw error;
  }
}

export async function getQueueHealth(): Promise<Record<string, QueueMetrics>> {
  const queueNames = ['proof-verification', 'reward-payout', 'notification-dispatch'];
  const metrics: Record<string, QueueMetrics> = {};

  await Promise.all(
    queueNames.map(async (name) => {
      try {
        metrics[name] = await getQueueMetrics(name);
      } catch (error) {
        // If we can't get metrics, return zeros
        metrics[name] = {
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
        };
      }
    }),
  );

  return metrics;
}

export function isQueueHealthy(queueName: string, metrics: QueueMetrics): boolean {
  const threshold = QUEUE_THRESHOLDS[queueName as keyof typeof QUEUE_THRESHOLDS];
  if (!threshold) return true;

  // Check if backlog exceeds threshold
  if (metrics.waiting > threshold.maxBacklog) {
    return false;
  }

  // Check if stalled (failed jobs) exceed threshold
  if (metrics.failed > threshold.maxStalled) {
    return false;
  }

  return true;
}

export async function getReadinessStatus(): Promise<HealthCheckResult> {
  const workers = getAllWorkerStatuses();
  const queues = await getQueueHealth();

  let status: 'ok' | 'degraded' = 'ok';

  // Check if critical workers are alive
  if (!workers['verification']?.alive) {
    status = 'degraded';
  }

  // Check queue health
  if (!isQueueHealthy('proof-verification', queues['proof-verification'])) {
    status = 'degraded';
  }
  if (!isQueueHealthy('reward-payout', queues['reward-payout'])) {
    status = 'degraded';
  }
  if (!isQueueHealthy('notification-dispatch', queues['notification-dispatch'])) {
    status = 'degraded';
  }

  return {
    status,
    workers,
    queues,
  };
}
