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

    const script = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("PEXPIRE", KEYS[1], ARGV[1])
      end
      local ttl = redis.call("PTTL", KEYS[1])
      if ttl == -1 then
        redis.call("PEXPIRE", KEYS[1], ARGV[1])
        ttl = tonumber(ARGV[1])
      end
      return {current, ttl}
    `;

    const results = (await client.eval(script, 1, key, windowMs)) as [number, number];
    const count = Number(results[0]);
    const ttlMs = Number(results[1]);

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
