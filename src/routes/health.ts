import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma.js';

const router = Router();

let healthRedis: any = null;

async function getRedisClient() {
  if (!healthRedis) {
    const mod = await import('ioredis');
    const Redis = (mod.default ?? mod) as any;
    healthRedis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      commandTimeout: 1500,
      enableOfflineQueue: false
    });
  }
  return healthRedis;
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

router.get('/', async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 1500);
    checks.database = 'ok';
  } catch (err: any) {
    checks.database = err.message === 'timeout' ? 'timeout' : 'error';
  }

  try {
    const redis = await getRedisClient();
    await withTimeout(redis.ping(), 1500);
    checks.redis = 'ok';
  } catch (err: any) {
    checks.redis = err.message === 'timeout' ? 'timeout' : 'error';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  const status = allOk ? 200 : 503;

  res.status(status).json({
    status: allOk ? 'healthy' : 'degraded',
    service: 'ecotask-backend',
    timestamp: new Date().toISOString(),
    checks,
  });
});

export default router;
