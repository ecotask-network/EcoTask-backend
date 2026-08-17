import config from '../config/default.js';
import { drainNotificationOutbox } from '../services/notificationOutboxService.js';
import logger from '../utils/logger.js';

export const DEFAULT_OUTBOX_SWEEP_INTERVAL_MS = 30 * 1000;

let timer: NodeJS.Timeout | null = null;

export async function runInitialOutboxDrain(): Promise<void> {
  try {
    const result = await drainNotificationOutbox();
    if (result.claimed > 0) {
      logger.info('Initial notification outbox drain completed', { ...result });
    }
  } catch (err) {
    logger.error('Initial notification outbox drain failed', { err });
  }
}

// Runs the outbox drainer on an interval so any PENDING rows left behind by
// a crash (e.g. the process died after the DB transaction committed but
// before the Redis enqueue happened) get picked up and delivered after
// restart, without requiring the original in-process flow to complete.
export function startOutboxSweeper(
  intervalMs: number = config.notification?.outboxSweepIntervalMs ||
    DEFAULT_OUTBOX_SWEEP_INTERVAL_MS,
): void {
  if (timer) return;
  void runInitialOutboxDrain();
  timer = setInterval(() => {
    drainNotificationOutbox().catch((err) => {
      logger.error('Scheduled notification outbox drain failed', { err });
    });
  }, intervalMs);
  timer.unref();
  logger.info('Notification outbox sweeper started', { intervalMs });
}

export function stopOutboxSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Notification outbox sweeper stopped');
  }
}
