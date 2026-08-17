import prisma from '../utils/prisma.js';

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
    Array<{ task_type: string; proof_count: bigint; total_reward: number | null }>
  >`
    SELECT
      t.type as task_type,
      COUNT(*) as proof_count,
      SUM(t.reward_amount) as total_reward
    FROM proofs p
    JOIN tasks t ON p.task_id = t.id
    WHERE p.user_id = ${id} AND p.status = 'APPROVED'
    GROUP BY t.type
  `;

  // Build response object with totals and byType breakdown
  const byType: Record<string, { count: number; reward: number }> = {};
  let totalApproved = 0;
  let totalReward = 0;

  aggResult.forEach((row) => {
    const count = Number(row.proof_count);
    const reward = row.total_reward ?? 0;

    byType[row.task_type] = { count, reward };
    totalApproved += count;
    totalReward += reward;
  });

  return {
    totalApproved,
    totalReward,
    byType,
  };
}
