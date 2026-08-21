import type { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { redisConnectionManager } from '../utils/redisConnectionManager.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Redis-backed fixed-window counter rate limiter.
 *
 * The underlying Redis client is shared with the auth challenge/denylist store
 * and the BullMQ queues via {@link redisConnectionManager}, and is created
 * lazily. Any Redis failure is surfaced to the caller so middleware can fail
 * open instead of blocking traffic.
 */
export class RedisRateLimiter {
  getClient(): Redis {
    return redisConnectionManager.getClient();
  }

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const client = this.getClient();
    const windowSeconds = Math.ceil(windowMs / 1000);

    const results = (await client.multi().incr(key).pttl(key).exec()) as Array<
      [null, number]
    >;
    const count = Number(results[0][1]);
    let ttlMs = Number(results[1][1]);

    if (ttlMs <= 0) {
      ttlMs = windowMs;
      await client.expire(key, windowSeconds);
    }

    const allowed = count <= limit;
    return {
      allowed,
      remaining: allowed ? Math.max(limit - count, 0) : 0,
      retryAfterSeconds: Math.ceil(ttlMs / 1000),
    };
  }

  async reset(key: string): Promise<void> {
    try {
      await this.getClient().del(key);
    } catch (err) {
      logger.error('Failed to reset rate limit key', { key, err });
    }
  }
}

export const rateLimiter = new RedisRateLimiter();
