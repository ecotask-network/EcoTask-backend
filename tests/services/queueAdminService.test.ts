import { EventEmitter } from 'events';
import { Queue } from 'bullmq';

jest.mock('bullmq', () => ({
  Queue: jest.fn(),
}));

// RedisConnectionManager attaches lifecycle event handlers to the client, so
// the fake needs EventEmitter behavior (mirrors upstream's FakeRedis).
class MockRedis extends EventEmitter {
  quit() {
    return Promise.resolve();
  }
  disconnect() {}
}

jest.mock('ioredis', () => ({
  __esModule: true,
  default: MockRedis,
}));

jest.mock('../../src/config/default', () => ({
  redis: { url: 'redis://localhost:6379' },
}));

import {
  closeAdminQueues,
  getQueueCounts,
  isAdminQueueName,
  JobNotFailedError,
  JobNotFoundError,
  listFailedJobs,
  retryFailedJob,
} from '../../src/services/queueAdminService';

const MockQueue = Queue as unknown as jest.Mock;
const fakeQueues = new Map<string, Record<string, jest.Mock>>();

type QueueSetup = {
  getJobCounts?: (types: string[]) => Promise<Record<string, number>>;
  getFailed?: () => Promise<unknown[]>;
  getJob?: (jobId: string) => Promise<unknown>;
};

// Per-test behavior for each queue name, consumed when the service lazily
// constructs its Queue instance on first use.
let queueSetup: Record<string, QueueSetup> = {};

beforeEach(async () => {
  jest.clearAllMocks();
  fakeQueues.clear();
  queueSetup = {};
  // Reset the service's lazy queue/connection cache so each test gets a
  // freshly constructed fake carrying this test's setup.
  await closeAdminQueues();
  MockQueue.mockImplementation((name: string) => {
    const setup = queueSetup[name] ?? {};
    const fake = {
      name,
      getJobCounts: jest.fn(setup.getJobCounts),
      getFailed: jest.fn(setup.getFailed),
      getJob: jest.fn(setup.getJob),
      close: jest.fn().mockResolvedValue(undefined),
    };
    fakeQueues.set(name, fake);
    return fake;
  });
});

type FakeJob = {
  id: string;
  name: string;
  data: Record<string, unknown>;
  attemptsMade: number;
  failedReason: string | null;
  stacktrace: string[];
  timestamp: number;
  finishedOn: number | null;
  isFailed: jest.Mock;
  retry: jest.Mock;
};

function failedJob(overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    id: 'job-1',
    name: 'verify',
    data: { proofId: 'proof-1' },
    attemptsMade: 3,
    failedReason: 'injected failure',
    stacktrace: ['Error: injected failure', '    at processor'],
    timestamp: 1700000000000,
    finishedOn: 1700000010000,
    isFailed: jest.fn().mockResolvedValue(true),
    retry: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('queueAdminService', () => {
  it('exposes only the verification and reward queues as admin queues', () => {
    expect(isAdminQueueName('proof-verification')).toBe(true);
    expect(isAdminQueueName('reward-payout')).toBe(true);
    expect(isAdminQueueName('notification-dispatch')).toBe(false);
    expect(isAdminQueueName('nope')).toBe(false);
  });

  it('reports waiting/active/completed/failed counts for a queue', async () => {
    queueSetup['proof-verification'] = {
      getJobCounts: async () => ({
        waiting: 4,
        active: 1,
        completed: 1000,
        failed: 2,
        delayed: 0,
        paused: 0,
      }),
    };

    const counts = await getQueueCounts('proof-verification');

    expect(counts).toEqual({
      queue: 'proof-verification',
      waiting: 4,
      active: 1,
      completed: 1000,
      failed: 2,
      delayed: 0,
      paused: 0,
    });
    expect(fakeQueues.get('proof-verification')!.getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused',
    );
  });

  it('lists failed jobs with pagination and a total', async () => {
    queueSetup['reward-payout'] = {
      getFailed: async () => [
        failedJob({ id: 'payout-1', name: 'payout', data: { payoutId: 'payout-1' } }),
      ],
      getJobCounts: async () => ({ failed: 1 }),
    };

    const page = await listFailedJobs('reward-payout', 50, 0);

    expect(fakeQueues.get('reward-payout')!.getFailed).toHaveBeenCalledWith(0, 49);
    expect(page).toEqual({
      items: [
        {
          id: 'payout-1',
          name: 'payout',
          data: { payoutId: 'payout-1' },
          attemptsMade: 3,
          failedReason: 'injected failure',
          stacktrace: ['Error: injected failure', '    at processor'],
          timestamp: 1700000000000,
          finishedOn: 1700000010000,
        },
      ],
      total: 1,
    });
  });

  it('retries a failed job and returns its queue and id', async () => {
    const job = failedJob();
    queueSetup['proof-verification'] = { getJob: async () => job };

    const result = await retryFailedJob('proof-verification', 'job-1');

    expect(fakeQueues.get('proof-verification')!.getJob).toHaveBeenCalledWith('job-1');
    expect(job.isFailed).toHaveBeenCalled();
    expect(job.retry).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ queue: 'proof-verification', jobId: 'job-1' });
  });

  it('rejects retry for an unknown job id', async () => {
    queueSetup['reward-payout'] = { getJob: async () => null };

    await expect(retryFailedJob('reward-payout', 'missing')).rejects.toThrow(
      JobNotFoundError,
    );
    await expect(retryFailedJob('reward-payout', 'missing')).rejects.toThrow(/not found/);
  });

  it('rejects retry for a job that is no longer failed', async () => {
    const job = failedJob({ failedReason: null });
    job.isFailed.mockResolvedValue(false);
    queueSetup['proof-verification'] = { getJob: async () => job };

    await expect(retryFailedJob('proof-verification', 'job-1')).rejects.toThrow(
      JobNotFailedError,
    );
    await expect(retryFailedJob('proof-verification', 'job-1')).rejects.toThrow(
      /not in the failed state/,
    );
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('an injected failure is listable and then retryable end-to-end', async () => {
    // Simulate a Redis-backed queue: the failed job lives in the failed list
    // until retry() moves it back to waiting, at which point it disappears
    // from the failed list and isFailed() flips to false.
    const registry = new Map<string, FakeJob>([
      ['job-1', failedJob({ failedReason: 'injected failure' })],
    ]);
    const job = registry.get('job-1')!;

    const failedJobs = async () => {
      const failed: FakeJob[] = [];
      for (const candidate of registry.values()) {
        if (await candidate.isFailed()) failed.push(candidate);
      }
      return failed;
    };

    queueSetup['proof-verification'] = {
      getFailed: failedJobs,
      getJobCounts: async () => ({ failed: (await failedJobs()).length }),
      getJob: async (id: string) => registry.get(id) ?? null,
    };
    job.retry.mockImplementation(async () => {
      job.failedReason = null;
      job.isFailed.mockResolvedValue(false);
    });

    // 1. The injected failure is visible in the failed list.
    const before = await listFailedJobs('proof-verification', 50, 0);
    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({
      id: 'job-1',
      failedReason: 'injected failure',
      attemptsMade: 3,
    });
    expect(before.total).toBe(1);

    // 2. Retrying clears it from the backlog.
    const result = await retryFailedJob('proof-verification', 'job-1');
    expect(result).toEqual({ queue: 'proof-verification', jobId: 'job-1' });
    expect(job.retry).toHaveBeenCalledTimes(1);

    const after = await listFailedJobs('proof-verification', 50, 0);
    expect(after.items).toHaveLength(0);
    expect(after.total).toBe(0);
  });
});
