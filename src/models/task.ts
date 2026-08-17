import prisma from '../utils/prisma.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';

export interface TaskFilters {
  type?: string;
  status?: TaskStatus;
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
    const cursor = decodeCursor(filters.cursor);
    const cursorDate = new Date(cursor.createdAt);

    if (cursor.id) {
      // Composite cursor: (createdAt, id) descending. Rows strictly after
      // the cursor row in that order are either older, or tied on
      // createdAt with a smaller id.
      where.OR = [
        { createdAt: { lt: cursorDate } },
        { createdAt: cursorDate, id: { lt: cursor.id } },
      ];
    } else {
      // Legacy bare-date cursor with no tie-breaker id: fall back to a
      // createdAt-only comparison for this one page. Rows sharing the
      // cursor's exact createdAt cannot be disambiguated without an id,
      // so they may be skipped or repeated on this page only — the
      // nextCursor we return is always the new composite format, so
      // subsequent pages self-heal.
      where.createdAt = { lt: cursorDate };
    }
  }

  const tasks = await prisma.task.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = tasks.length > limit;
  const items = hasMore ? tasks.slice(0, limit) : tasks;
  const last = items[items.length - 1];
  const nextCursor = hasMore ? encodeCursor(last.createdAt, last.id) : null;

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
  maxCompletions?: number;
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
    maxCompletions?: number;
    status?: TaskStatus;
    expiresAt?: Date;
  },
) {
  return prisma.task.update({ where: { id }, data });
}

export async function deleteTask(id: string) {
  return prisma.task.delete({ where: { id } });
}

export async function getTaskCompletionCount(taskId: string): Promise<number> {
  return prisma.proof.count({ where: { taskId, status: 'APPROVED' } });
}

export async function completeTaskIfFull(taskId: string): Promise<boolean> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, status: true, maxCompletions: true },
  });
  if (!task || task.maxCompletions == null || task.status !== TaskStatus.ACTIVE)
    return false;

  const completed = await getTaskCompletionCount(taskId);
  if (completed < task.maxCompletions) return false;

  await prisma.task.update({
    where: { id: taskId },
    data: { status: TaskStatus.COMPLETED },
  });
  return true;
}
