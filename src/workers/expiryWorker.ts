import config from '../config/default.js';
import { expireOverdueTasks, recoverOrphanedProofs } from '../services/taskService.js';
import logger from '../utils/logger.js';

export const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export async function runInitialSweep(): Promise<void> {
  const p1 = expireOverdueTasks()
    .then((result) => {
      if (result.tasksExpired > 0 || result.claimsExpired > 0) {
        logger.info('Initial expiry sweep completed', {
          tasksExpired: result.tasksExpired,
          claimsExpired: result.claimsExpired,
        });
      }
    })
    .catch((err) => {
      logger.error('Initial expiry sweep failed', { err });
    });

  const p2 = recoverOrphanedProofs()
    .then((recoveredCount) => {
      if (recoveredCount > 0) {
        logger.info('Initial orphaned proofs recovery completed', { recoveredCount });
      }
    })
    .catch((err) => {
      logger.error('Initial orphaned proofs recovery failed', { err });
    });

  await Promise.all([p1, p2]);
}

export function startExpirySweeper(
  intervalMs: number = config.expirySweepIntervalMs || DEFAULT_SWEEP_INTERVAL_MS,
): void {
  if (timer) return;
  void runInitialSweep();
  timer = setInterval(() => {
    expireOverdueTasks().catch((err) => {
      logger.error('Scheduled expiry sweep failed', { err });
    });
    recoverOrphanedProofs().catch((err) => {
      logger.error('Scheduled orphaned proofs recovery failed', { err });
    });
  }, intervalMs);
  timer.unref();
  logger.info('Expiry sweeper started', { intervalMs });
}

export function stopExpirySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Expiry sweeper stopped');
  }
}
