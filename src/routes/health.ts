import { Router, Request, Response } from "express";
import prisma from "../utils/prisma.js";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }

  try {
    const { default: IORedis } = await import("ioredis");
    const redis = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      connectTimeout: 2000,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    await redis.connect();
    await redis.ping();
    await redis.quit();
    checks.redis = "ok";
  } catch {
    checks.redis = "error";
  }

  const allOk = Object.values(checks).every((v) => v === "ok");
  const status = allOk ? 200 : 503;

  res.status(status).json({
    status: allOk ? "healthy" : "degraded",
    service: "ecotask-backend",
    timestamp: new Date().toISOString(),
    checks,
  });
});

export default router;
