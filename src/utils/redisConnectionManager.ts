import IORedis from 'ioredis';
import type { Redis, RedisOptions } from 'ioredis';
import config from '../config/default.js';
import logger from '../utils/logger.js';

/**
 * Connection states we expose for observability. The values mirror ioredis's
 * own `status` field where applicable, with a few extra states for the
 * pre-connect and timed-out cases.
 */
export type RedisHealthStatus =
  | 'idle'
  | 'wait'
  | 'connecting'
  | 'connect'
  | 'ready'
  | 'reconnecting'
  | 'close'
  | 'end'
  | 'error'
  | 'timeout';

export interface RedisHealth {
  healthy: boolean;
  status: RedisHealthStatus;
}

export interface RedisConnectionManagerConfig {
  url?: string;
  maxRetriesPerRequest?: number | null;
  retryStrategy?: (times: number) => number | void | null;
  /** Injectable factory so tests can exercise a dropped connection deterministically. */
  createClient?: (url: string, options: RedisOptions) => Redis;
}

const DEFAULT_BASE_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const RETRY_JITTER_MS = 500;

/**
 * Uniform reconnection backoff shared by every subsystem. ioredis invokes this
 * with a 1-based attempt count and waits for the returned number of
 * milliseconds before trying again.
 */
export function exponentialBackoffRetryStrategy(times: number): number {
  const exponential = DEFAULT_BASE_RETRY_DELAY_MS * 2 ** Math.max(0, times - 1);
  const delay = Math.min(exponential, DEFAULT_MAX_RETRY_DELAY_MS);
  return delay + Math.floor(Math.random() * RETRY_JITTER_MS);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Lazily creates and shares a single ioredis connection for the rate limiter,
 * the auth challenge/denylist store, and all three BullMQ queues/workers.
 *
 * Importing this module never opens a socket: the client is only constructed on
 * the first `getClient()` call, preserving the lazy-init guarantees the
 * callers rely on. All lifecycle events funnel through one set of handlers so
 * a partial Redis outage is handled and logged uniformly instead of per-module.
 */
export class RedisConnectionManager {
  private client: Redis | null = null;
  private readonly url: string;
  private readonly options: RedisOptions;
  private readonly createClient: (url: string, options: RedisOptions) => Redis;

  constructor(managerConfig: RedisConnectionManagerConfig = {}) {
    this.url = managerConfig.url ?? 'redis://localhost:6379';
    this.createClient =
      managerConfig.createClient ?? ((url, options) => new IORedis(url, options));
    this.options = {
      maxRetriesPerRequest: managerConfig.maxRetriesPerRequest ?? null,
      retryStrategy: managerConfig.retryStrategy ?? exponentialBackoffRetryStrategy,
    };
  }

  getClient(): Redis {
    if (!this.client) {
      const client = this.createClient(this.url, this.options);
      this.attachLifecycleHandlers(client);
      this.client = client;
    }
    return this.client;
  }

  isHealthy(): boolean {
    return this.client?.status === 'ready';
  }

  async healthCheck(timeoutMs = 1500): Promise<RedisHealth> {
    const client = this.getClient();

    // A client stuck in a non-ready state (wait/reconnecting/close/end) is
    // already unhealthy; short-circuit before issuing a command that would
    // otherwise sit in the offline queue waiting for a reconnect.
    if (client.status !== 'ready') {
      return { healthy: false, status: client.status as RedisHealthStatus };
    }

    try {
      await withTimeout(client.ping(), timeoutMs);
      return { healthy: true, status: 'ready' };
    } catch (err) {
      const status: RedisHealthStatus =
        err instanceof Error && err.message === 'timeout' ? 'timeout' : 'error';
      return { healthy: false, status };
    }
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  private attachLifecycleHandlers(client: Redis): void {
    // ioredis emits 'error' on any connection-level failure. Without a listener
    // this becomes an unhandled 'error' event that crashes the process, so this
    // single handler is what keeps every subsystem resilient to outages.
    client.on('error', (err: Error) => {
      logger.error('Redis connection error', { err });
    });
    client.on('connect', () => {
      logger.info('Redis connected');
    });
    client.on('ready', () => {
      logger.info('Redis connection ready');
    });
    client.on('reconnecting', (delay: number) => {
      logger.warn('Redis connection lost, reconnecting', { delayMs: delay });
    });
    client.on('close', () => {
      logger.warn('Redis connection closed');
    });
    client.on('end', () => {
      logger.warn('Redis connection ended, no further retries');
    });
  }
}

export const redisConnectionManager = new RedisConnectionManager({
  url: config.redis.url,
});
