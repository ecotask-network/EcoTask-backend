import { Request, Response } from "express";
import prisma from "../utils/prisma.js";

export async function getLeaderboard(req: Request, res: Response) {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const period = (req.query.period as string) || "all";

  let dateFilter: Date | undefined;
  if (period === "week") {
    dateFilter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === "month") {
    dateFilter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }

  const where = {
    status: "APPROVED" as const,
    ...(dateFilter ? { createdAt: { gte: dateFilter } } : {}),
  };

  const results = await prisma.proof.groupBy({
    by: ["userId"],
    where,
    _count: { id: true },
    _sum: { taskId: true },
    orderBy: { _count: { id: "desc" } },
    take: limit,
  });

  const userIds = results.map((r) => r.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, wallet: true, name: true, avatarUrl: true },
  });

  const userMap = new Map(users.map((u) => [u.id, u]));

  const leaderboard = results.map((entry, index) => ({
    rank: index + 1,
    userId: entry.userId,
    wallet: userMap.get(entry.userId)?.wallet || "",
    name: userMap.get(entry.userId)?.name || null,
    avatarUrl: userMap.get(entry.userId)?.avatarUrl || null,
    approvedProofs: entry._count.id,
  }));

  res.json({ leaderboard, period });
}
