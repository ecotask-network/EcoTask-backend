import prisma from '../utils/prisma.js';
import { formatRewardAmount } from '../utils/reward.js';

export async function findOrCreateUser(wallet: string) {
  let user = await prisma.user.findUnique({ where: { wallet } });
  if (!user) {
    user = await prisma.user.create({ data: { wallet } });
  }
  return user;
}

export async function getUserById(id: string) {
  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      wallet: true,
      name: true,
      bio: true,
      avatarUrl: true,
      role: true,
      createdAt: true,
    },
  });
}

export async function updateUser(
  id: string,
  data: { name?: string; bio?: string; avatarUrl?: string },
) {
  return prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      wallet: true,
      name: true,
      bio: true,
      avatarUrl: true,
      role: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getUserImpact(id: string) {
  // Use raw SQL aggregation for true single-query performance with indexed columns
  const aggResult = await prisma.$queryRaw<
    Array<{ task_type: string; proof_count: bigint; total_reward_micros: bigint | null }>
  >`
    SELECT
      t.type as task_type,
      COUNT(*) as proof_count,
      SUM(t.reward_amount_micros) as total_reward_micros
    FROM proofs p
    JOIN tasks t ON p.task_id = t.id
    WHERE p.user_id = ${id} AND p.status = 'APPROVED'
    GROUP BY t.type
  `;

  // Build response object with totals and byType breakdown
  const byType: Record<string, { count: number; reward: string }> = {};
  let totalApproved = 0;
  let totalRewardMicros = 0n;

  aggResult.forEach((row) => {
    const count = Number(row.proof_count);
    const rewardMicros = row.total_reward_micros ?? 0n;

    byType[row.task_type] = { count, reward: formatRewardAmount(rewardMicros) };
    totalApproved += count;
    totalRewardMicros += rewardMicros;
  });

  return {
    totalApproved,
    totalReward: formatRewardAmount(totalRewardMicros),
    byType,
  };
}
