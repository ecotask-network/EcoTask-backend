import prisma from '../utils/prisma.js';
import config from '../config/default.js';
import logger from '../utils/logger.js';
import { enqueueNotificationDispatch } from '../workers/notificationWorker.js';

export const DEFAULT_OUTBOX_BATCH_SIZE = 20;
export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 3;

export interface DrainResult {
  claimed: number;
  sent: number;
  retried: number;
  deadLettered: number;
}

// Exponential backoff between enqueue retries, aligned with the
// `attempts: 3, backoff: { type: 'exponential', delay: 5000 }` convention
// already used by the BullMQ queues in this codebase.
function nextBackoffMs(attempts: number): number {
  return 5000 * 2 ** attempts;
}

/**
 * Drains PENDING outbox rows (oldest first) into the BullMQ
 * notification-dispatch queue. This is the recovery path for the
 * transactional outbox: a row exists as soon as the triggering DB
 * transaction commits, independent of whether the enqueue to Redis ever
 * happened. Calling this repeatedly (on a timer, or after a crash restart)
 * is what guarantees at-least-once delivery.
 *
 * Idempotency/concurrency: each row is claimed with a conditional
 * `updateMany` (`WHERE id = ? AND status = 'PENDING'`) before it is
 * enqueued. If two drain calls race for the same row, only one claim
 * succeeds — the loser skips the row instead of enqueueing a duplicate
 * job. As a second layer of protection, the outbox row's id is used as the
 * BullMQ jobId, so even a duplicate enqueue attempt would be deduped by
 * BullMQ rather than creating a second job.
 */
export async function drainNotificationOutbox(
  batchSize: number = config.notification?.outboxBatchSize ?? DEFAULT_OUTBOX_BATCH_SIZE,
  maxAttempts: number = config.notification?.outboxMaxAttempts ??
    DEFAULT_OUTBOX_MAX_ATTEMPTS,
): Promise<DrainResult> {
  const now = new Date();
  const result: DrainResult = { claimed: 0, sent: 0, retried: 0, deadLettered: 0 };

  const candidates = await prisma.notificationOutbox.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  });

  for (const row of candidates) {
    const claim = await prisma.notificationOutbox.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });
    if (claim.count === 0) {
      // Another drain call already claimed this row between our read and
      // our write — skip it to stay idempotent.
      continue;
    }
    result.claimed += 1;

    try {
      if (row.requestId) {
        await enqueueNotificationDispatch(row.id, row.notificationId, row.requestId);
      } else {
        await enqueueNotificationDispatch(row.id, row.notificationId);
      }
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { status: 'SENT', attempts: row.attempts + 1, lastError: null },
      });
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;

      if (attempts >= maxAttempts) {
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: { status: 'DEAD_LETTER', attempts, lastError: message },
        });
        result.deadLettered += 1;
        logger.error('Notification outbox row dead-lettered after max attempts', {
          outboxId: row.id,
          notificationId: row.notificationId,
          attempts,
          ...(row.requestId ? { requestId: row.requestId } : {}),
          err,
        });
      } else {
        await prisma.notificationOutbox.update({
          where: { id: row.id },
          data: {
            status: 'PENDING',
            attempts,
            lastError: message,
            nextAttemptAt: new Date(Date.now() + nextBackoffMs(attempts)),
          },
        });
        result.retried += 1;
        logger.error('Notification outbox enqueue failed, will retry', {
          outboxId: row.id,
          notificationId: row.notificationId,
          attempts,
          ...(row.requestId ? { requestId: row.requestId } : {}),
          err,
        });
      }
    }
  }

  return result;
}

/**
 * Admin/ops-facing read of dead-lettered outbox rows — the observable
 * surface for notifications that exhausted all delivery attempts.
 */
export async function listDeadLetteredNotifications(limit = 50, offset = 0) {
  const [items, total] = await Promise.all([
    prisma.notificationOutbox.findMany({
      where: { status: 'DEAD_LETTER' },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
      include: { notification: true },
    }),
    prisma.notificationOutbox.count({ where: { status: 'DEAD_LETTER' } }),
  ]);
  return { items, total };
}
