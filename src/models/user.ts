import prisma from "../utils/prisma.js";

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

export async function updateUser(id: string, data: { name?: string; bio?: string; avatarUrl?: string }) {
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
  const proofs = await prisma.proof.findMany({
    where: { userId: id, status: "APPROVED" },
    include: { task: { select: { type: true, rewardAmount: true } } },
  });

  return {
    totalApproved: proofs.length,
    totalReward: proofs.reduce((sum, p) => sum + p.task.rewardAmount, 0),
    byType: proofs.reduce<Record<string, { count: number; reward: number }>>((acc, p) => {
      if (!acc[p.task.type]) acc[p.task.type] = { count: 0, reward: 0 };
      acc[p.task.type].count++;
      acc[p.task.type].reward += p.task.rewardAmount;
      return acc;
    }, {}),
  };
}
