import { Request, Response } from 'express';
import prisma from '../utils/prisma.js';

export async function getPlatformAnalytics(_req: Request, res: Response) {
  const [totalTasks, activeTasks, totalUsers, totalProofs, approvedProofs] =
    await Promise.all([
      prisma.task.count(),
      prisma.task.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count(),
      prisma.proof.count(),
      prisma.proof.findMany({
        where: { status: 'APPROVED' },
        select: { task: { select: { rewardAmount: true } } },
      }),
    ]);

  const totalRewardPaid = approvedProofs.reduce(
    (sum, proof) => sum + proof.task.rewardAmount,
    0,
  );

  return res.json({
    totals: {
      tasks: totalTasks,
      activeTasks,
      users: totalUsers,
      proofs: totalProofs,
      approvedProofs: approvedProofs.length,
      totalRewardPaid,
    },
    timestamp: new Date().toISOString(),
  });
}
