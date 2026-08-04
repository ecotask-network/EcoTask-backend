import prisma from '../utils/prisma.js';

export interface TaskFilters {
  type?: string;
  status?: string;
  minReward?: number;
  maxReward?: number;
  swLat?: number;
  swLng?: number;
  neLat?: number;
  neLng?: number;
  cursor?: string;
  limit?: number;
}

export async function listTasks(filters: TaskFilters = {}) {
  const where: Record<string, unknown> = {};
  const limit = filters.limit || 20;

  if (filters.type) where.type = filters.type;
  if (filters.status) where.status = filters.status;

  if (filters.minReward != null || filters.maxReward != null) {
    const rewardFilter: Record<string, number> = {};
    if (filters.minReward != null) rewardFilter.gte = filters.minReward;
    if (filters.maxReward != null) rewardFilter.lte = filters.maxReward;
    where.rewardAmount = rewardFilter;
  }

  if (
    filters.swLat != null &&
    filters.swLng != null &&
    filters.neLat != null &&
    filters.neLng != null
  ) {
    where.AND = [
      { lat: { gte: filters.swLat, lte: filters.neLat } },
      { lng: { gte: filters.swLng, lte: filters.neLng } },
    ];
  }

  if (filters.cursor) {
    where.createdAt = { lt: new Date(filters.cursor) };
  }

  const tasks = await prisma.task.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });

  const hasMore = tasks.length > limit;
  const items = hasMore ? tasks.slice(0, limit) : tasks;
  const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null;

  return { items, nextCursor };
}

export async function getTaskById(id: string) {
  return prisma.task.findUnique({ where: { id } });
}

export async function createTask(data: {
  title: string;
  description?: string;
  type: string;
  rewardAmount: number;
  lat: number;
  lng: number;
  radiusMeters?: number;
  expiresAt?: Date;
}) {
  return prisma.task.create({ data });
}

export async function updateTask(
  id: string,
  data: {
    title?: string;
    description?: string;
    type?: string;
    rewardAmount?: number;
    lat?: number;
    lng?: number;
    radiusMeters?: number;
    status?: string;
    expiresAt?: Date;
  },
) {
  return prisma.task.update({ where: { id }, data });
}

export async function deleteTask(id: string) {
  return prisma.task.delete({ where: { id } });
}
