import prisma from '../utils/prisma.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import type { Prisma } from '@prisma/client';

export interface TaskFilters {
  type?: string;
  status?: string;
  minRewardMicros?: bigint;
  maxRewardMicros?: bigint;
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

  if (filters.minRewardMicros != null || filters.maxRewardMicros != null) {
    const rewardFilter: Record<string, bigint> = {};
    if (filters.minRewardMicros != null) rewardFilter.gte = filters.minRewardMicros;
    if (filters.maxRewardMicros != null) rewardFilter.lte = filters.maxRewardMicros;
    where.rewardAmountMicros = rewardFilter;
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
      // so they may be skipped or repeated on this page only â€” the
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
  rewardAmountMicros: bigint;
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
    rewardAmountMicros?: bigint;
    lat?: number;
    lng?: number;
    radiusMeters?: number;
    maxCompletions?: number;
    status?: string;
    expiresAt?: Date;
  },
) {
  return prisma.task.update({ where: { id }, data });
}

export async function deleteTask(id: string) {
  return prisma.task.delete({ where: { id } });
}

export type SlotClaimResult =
  | { claimed: true; taskCompleted: boolean }
  | { claimed: false };

/**
 * Atomically claims one completion slot on a task, transitioning it to
 * COMPLETED if this was the last slot. Must be called inside the same
 * transaction that sets a proof's status to APPROVED. The UPDATE's WHERE
 * clause (status ACTIVE AND completedCount < maxCompletions) and the row
 * lock Postgres takes during the UPDATE make this race-free: concurrent
 * callers serialize on this row, and a caller that loses the race gets
 * zero rows back instead of a stale count.
 */
type SlotRow = { completed_count: number; max_completions: number | null; status: string };

export async function claimCompletionSlot(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<SlotClaimResult> {
  const rows = await tx.$queryRaw<SlotRow[]>`
    UPDATE tasks
    SET completed_count = completed_count + 1,
        status = CASE
          WHEN max_completions IS NOT NULL AND completed_count + 1 >= max_completions
          THEN 'COMPLETED' ELSE status
        END
    WHERE id = ${taskId} AND status = 'ACTIVE'
      AND (max_completions IS NULL OR completed_count < max_completions)
    RETURNING completed_count, max_completions, status
  `;

  if (rows.length === 0) return { claimed: false };
  return { claimed: true, taskCompleted: rows[0].status === 'COMPLETED' };
}
