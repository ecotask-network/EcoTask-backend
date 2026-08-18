import IORedis from 'ioredis';
import config from '../config/default.js';
import logger from '../utils/logger.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Redis-backed fixed-window counter rate limiter.
 *
 * The Redis client is created lazily and any Redis failure is surfaced to the
 * caller so middleware can fail open instead of blocking traffic.
 */
export class RedisRateLimiter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getClient(): any {
    if (!this.client) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client = new IORedis(config.redis.url, { maxRetriesPerRequest: null }) as any;
      this.client.on('error', () => {
        // A failing Redis connection must not crash the API; middleware fails open.
      });
    }
    return this.client;
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
