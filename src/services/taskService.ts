import prisma from '../utils/prisma.js';
import logger from '../utils/logger.js';
import { TaskStatus, ClaimStatus } from '@prisma/client';

export interface ExpirySweepResult {
  tasksExpired: number;
  claimsExpired: number;
}

export async function expireOverdueTasks(): Promise<ExpirySweepResult> {
  const now = new Date();

  const tasks = await prisma.task.updateMany({
    where: { status: TaskStatus.ACTIVE, expiresAt: { lt: now } },
    data: { status: TaskStatus.EXPIRED },
  });

  const claims = await prisma.taskClaim.updateMany({
    where: { status: ClaimStatus.ACTIVE, expiresAt: { lt: now } },
    data: { status: ClaimStatus.EXPIRED },
  });

  if (tasks.count > 0 || claims.count > 0) {
    logger.info('Expiry sweep completed', {
      tasksExpired: tasks.count,
      claimsExpired: claims.count,
    });
  }

  return { tasksExpired: tasks.count, claimsExpired: claims.count };
}
