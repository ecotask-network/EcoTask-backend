import prisma from '../utils/prisma.js';
import { enqueueRewardPayout } from '../workers/rewardWorker.js';
import logger from '../utils/logger.js';
import config from '../config/default.js';

export const DEFAULT_PAYOUT_SWEEP_INTERVAL_MS = 30 * 1000;
export const DEFAULT_PAYOUT_BATCH_SIZE = 20;
export const DEFAULT_PAYOUT_MAX_ATTEMPTS = 3;
const STALE_PROCESSING_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

function nextBackoffMs(attempts: number): number {
  return 5000 * 2 ** attempts;
}

export interface PayoutSweepResult {
  enqueued: number;
  reclaimed: number;
  deadLettered: number;
}

/**
 * Drains PENDING reward-payout outbox rows into the BullMQ reward-payout
 * queue. Each row is claimed with a conditional updateMany before enqueueing,
 * so two concurrent sweepers cannot both enqueue the same row. The payoutId
 * is also used as the BullMQ jobId, providing a second dedup layer.
 *
 * Also reclaims stale PROCESSING rows (worker crashed between claim and
 * completion) by resetting them to PENDING for retry, up to max attempts.
 */
export async function drainRewardPayouts(
  batchSize: number = config.notification?.outboxBatchSize ?? DEFAULT_PAYOUT_BATCH_SIZE,
  maxAttempts: number = DEFAULT_PAYOUT_MAX_ATTEMPTS,
): Promise<PayoutSweepResult> {
  const now = new Date();
  const result: PayoutSweepResult = { enqueued: 0, reclaimed: 0, deadLettered: 0 };

  const candidates = await prisma.rewardPayout.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  });

  for (const row of candidates) {
    const claim = await prisma.rewardPayout.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'PENDING' },
    });
    if (claim.count === 0) continue;

    try {
      await enqueueRewardPayout(row.id, row.proofId, row.requestId ?? undefined);
      result.enqueued += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;

      if (attempts >= maxAttempts) {
        await prisma.rewardPayout.update({
          where: { id: row.id },
          data: { status: 'FAILED', attempts, lastError: message },
        });
        result.deadLettered += 1;
      } else {
        await prisma.rewardPayout.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: message,
            nextAttemptAt: new Date(Date.now() + nextBackoffMs(attempts)),
          },
        });
      }
      logger.error('Reward payout enqueue failed', {
        payoutId: row.id,
        proofId: row.proofId,
        attempts,
        err,
      });
    }
  }

  const staleThreshold = new Date(now.getTime() - STALE_PROCESSING_MS);
  const staleRows = await prisma.rewardPayout.findMany({
    where: {
      status: 'PROCESSING',
      createdAt: { lt: staleThreshold },
    },
    take: batchSize,
  });

  for (const row of staleRows) {
    if (row.attempts >= maxAttempts) {
      await prisma.rewardPayout.update({
        where: { id: row.id },
        data: { status: 'FAILED', lastError: 'Max attempts exceeded (stale PROCESSING)' },
      });
      result.deadLettered += 1;
      logger.error('Reward payout dead-lettered after max attempts', {
        payoutId: row.id,
        proofId: row.proofId,
        attempts: row.attempts,
      });
    } else {
      await prisma.rewardPayout.update({
        where: { id: row.id },
        data: {
          status: 'PENDING',
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(),
        },
      });
      result.reclaimed += 1;
      logger.info('Reclaimed stale PROCESSING payout row', {
        payoutId: row.id,
        proofId: row.proofId,
        attempts: row.attempts + 1,
      });
    }
  }

  return result;
}

export async function runInitialPayoutDrain(): Promise<void> {
  try {
    const result = await drainRewardPayouts();
    if (result.enqueued > 0 || result.reclaimed > 0) {
      logger.info('Initial reward payout drain completed', { ...result });
    }
  } catch (err) {
    logger.error('Initial reward payout drain failed', { err });
  }
}

export function startRewardPayoutSweeper(
  intervalMs: number = config.notification?.outboxSweepIntervalMs ||
    DEFAULT_PAYOUT_SWEEP_INTERVAL_MS,
): void {
  if (timer) return;
  void runInitialPayoutDrain();
  timer = setInterval(() => {
    drainRewardPayouts().catch((err) => {
      logger.error('Scheduled reward payout drain failed', { err });
    });
  }, intervalMs);
  timer.unref();
  logger.info('Reward payout sweeper started', { intervalMs });
}

export function stopRewardPayoutSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Reward payout sweeper stopped');
  }
}
