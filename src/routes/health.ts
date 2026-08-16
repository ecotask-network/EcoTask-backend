import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma.js';
import { getReadinessStatus } from '../utils/workerHealth.js';

const router = Router();

// Liveness endpoint - checks if the service is running (Postgres + Redis only)
// Used by Docker HEALTHCHECK
router.get('/', async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }

  try {
    const mod = await import('ioredis');
    const Redis = (mod.default ?? mod) as unknown as new (...args: unknown[]) => {
      connect(): Promise<void>;
      ping(): Promise<string>;
      quit(): Promise<void>;
    };
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    await redis.connect();
    await redis.ping();
    await redis.quit();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'error';
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

// Readiness endpoint - checks if the service is ready to handle traffic
// Includes worker health and queue metrics
router.get('/readiness', async (_req: Request, res: Response) => {
  try {
    const readiness = await getReadinessStatus();
    const status = readiness.status === 'ok' ? 200 : 503;

    res.status(status).json({
      status: readiness.status,
      service: 'ecotask-backend',
      timestamp: new Date().toISOString(),
      workers: readiness.workers,
      queues: readiness.queues,
    });
  } catch (error) {
    // Log error but don't expose details
    res.status(503).json({
      status: 'degraded',
      service: 'ecotask-backend',
      timestamp: new Date().toISOString(),
      error: 'Failed to check readiness',
    });
  }
});

export default router;
