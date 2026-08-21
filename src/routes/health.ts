import { Router, Request, Response } from 'express';
import type IORedis from 'ioredis';
import prisma from '../utils/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

let healthRedis: IORedis | null = null;

async function getRedisClient(): Promise<IORedis> {
  if (healthRedis) return healthRedis;

  const mod = await import('ioredis');
  // ioredis's CJS/ESM interop typing doesn't resolve a constructable default
  // export through a dynamic import namespace; the same cast pattern is used
  // for its static import elsewhere in this codebase (see workers/rewardWorker.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const RedisCtor = (mod.default ?? mod) as any;
  const client: IORedis = new RedisCtor(
    process.env.REDIS_URL || 'redis://localhost:6379',
    {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      commandTimeout: 1500,
      enableOfflineQueue: false,
    },
  );
  healthRedis = client;
  return client;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const checks: Record<string, string> = {};

    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, 1500);
      checks.database = 'ok';
    } catch (err) {
      checks.database =
        err instanceof Error && err.message === 'timeout' ? 'timeout' : 'error';
    }

    try {
      const redis = await getRedisClient();
      await withTimeout(redis.ping(), 1500);
      checks.redis = 'ok';
    } catch (err) {
      checks.redis =
        err instanceof Error && err.message === 'timeout' ? 'timeout' : 'error';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    const status = allOk ? 200 : 503;

    res.status(status).json({
      status: allOk ? 'healthy' : 'degraded',
      service: 'ecotask-backend',
      timestamp: new Date().toISOString(),
      checks,
    });
  }),
);

export default router;
