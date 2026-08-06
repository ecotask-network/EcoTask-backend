import prisma from '../utils/prisma.js';
import logger from '../utils/logger.js';

export interface ExpirySweepResult {
  tasksExpired: number;
  claimsExpired: number;
}

export async function expireOverdueTasks(): Promise<ExpirySweepResult> {
  const now = new Date();

  const tasks = await prisma.task.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });

  const claims = await prisma.taskClaim.updateMany({
    where: { status: 'active', expiresAt: { lt: now } },
    data: { status: 'expired' },
  });

  if (tasks.count > 0 || claims.count > 0) {
    logger.info('Expiry sweep completed', {
      tasksExpired: tasks.count,
      claimsExpired: claims.count,
    });
  }

  return { tasksExpired: tasks.count, claimsExpired: claims.count };
}
