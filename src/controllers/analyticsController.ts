import { Request, Response } from 'express';
import prisma from '../utils/prisma.js';
import { formatRewardAmount } from '../utils/reward.js';

export async function getPlatformAnalytics(_req: Request, res: Response) {
  const [totalTasks, activeTasks, totalUsers, totalProofs, approvedProofs] =
    await Promise.all([
      prisma.task.count(),
      prisma.task.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count(),
      prisma.proof.count(),
      prisma.proof.findMany({
        where: { status: 'APPROVED' },
        select: { task: { select: { rewardAmountMicros: true } } },
      }),
    ]);

  const totalRewardPaidMicros = approvedProofs.reduce(
    (sum, proof) => sum + proof.task.rewardAmountMicros,
    0n,
  );
  const totalRewardPaid = formatRewardAmount(totalRewardPaidMicros);

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

export async function getTrends(req: Request, res: Response) {
  const requestedDays = parseInt(req.query.days as string) || 30;
  const days = Math.min(Math.max(requestedDays, 1), 365);
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.$queryRaw<
    Array<{ day: Date; count: number; reward_micros: bigint }>
  >`
    SELECT DATE_TRUNC('day', p."created_at")::date AS day,
           COUNT(*)::int AS count,
           COALESCE(SUM(t."reward_amount_micros"), 0)::bigint AS reward_micros
    FROM "proofs" p
    JOIN "tasks" t ON p."task_id" = t.id
    WHERE p.status = 'APPROVED'
      AND p."created_at" >= ${from}
    GROUP BY day
    ORDER BY day ASC
  `;

  return res.json({
    days,
    points: rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      approvedProofs: Number(r.count),
      totalReward: formatRewardAmount(r.reward_micros),
    })),
    timestamp: new Date().toISOString(),
  });
}
