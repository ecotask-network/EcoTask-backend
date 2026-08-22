// Use fake timers so we can control setTimeout delays in retry logic
jest.useFakeTimers();

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: { $executeRaw: jest.fn() },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import prisma from '../../src/utils/prisma';
import logger from '../../src/utils/logger';
import { logAudit, AuditLogEntry } from '../../src/services/auditService';

const mockExecuteRaw = prisma.$executeRaw as unknown as jest.Mock;
const mockLogger = logger as unknown as {
  warn: jest.Mock;
  error: jest.Mock;
};

const baseEntry: AuditLogEntry = {
  userId: 'user-1',
  action: 'proof.submit',
  resource: 'proof',
  resourceId: 'proof-1',
  details: { method: 'POST', path: '/proofs', body: {} },
  ip: '127.0.0.1',
  outcome: 'SUCCESS',
  statusCode: 201,
  durationMs: 42,
};

/**
 * Flush the setImmediate-based drain and all pending micro/macro tasks.
 * With fake timers, setImmediate callbacks are executed by jest.runAllTimers().
 * We then drain the promise queue by chaining resolved promises.
 */
async function flushQueue(): Promise<void> {
  jest.runAllTimers();
  // Drain promise micro-tasks multiple times to let async/await chains resolve
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('auditService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    // Drain any leftover timers / promises so they don't leak into next test
    jest.runAllTimers();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });

  describe('logAudit (queue + drain)', () => {
    it('writes an audit entry via prisma.$executeRaw', async () => {
      mockExecuteRaw.mockResolvedValueOnce(1);

      logAudit(baseEntry);
      await flushQueue();

      expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    });

    it('is synchronous (void return) — does not return a Promise', () => {
      mockExecuteRaw.mockResolvedValue(1);
      const result = logAudit(baseEntry);
      expect(result).toBeUndefined();
    });

    it('passes outcome, statusCode and durationMs — observable via call count', async () => {
      mockExecuteRaw.mockResolvedValueOnce(1);

      logAudit({ ...baseEntry, outcome: 'FAILURE', statusCode: 403, durationMs: 99 });
      await flushQueue();

      // Entry must be written, never silently dropped
      expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry on transient failure', () => {
    it('retries up to 3 times and raises logger.error after exhaustion', async () => {
      const dbError = new Error('connection reset');
      mockExecuteRaw.mockRejectedValue(dbError);

      logAudit(baseEntry);

      // Attempt 1: setImmediate triggers drain
      jest.runAllTimers();
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Back-off after attempt 1 = 100 ms
      jest.advanceTimersByTime(100);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Back-off after attempt 2 = 200 ms
      jest.advanceTimersByTime(200);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(mockExecuteRaw).toHaveBeenCalledTimes(3);
      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringMatching(/permanently failed/i),
        expect.objectContaining({ action: 'proof.submit' }),
      );
    });

    it('succeeds on a later attempt without alerting', async () => {
      const dbError = new Error('transient');
      mockExecuteRaw
        .mockRejectedValueOnce(dbError)
        .mockRejectedValueOnce(dbError)
        .mockResolvedValueOnce(1);

      logAudit(baseEntry);

      // Attempt 1
      jest.runAllTimers();
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Retry 1 after 100ms
      jest.advanceTimersByTime(100);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      // Retry 2 after 200ms — succeeds
      jest.advanceTimersByTime(200);
      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(mockExecuteRaw).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('queue isolation', () => {
    it('drains multiple enqueued entries independently', async () => {
      mockExecuteRaw.mockResolvedValue(1);

      logAudit({ ...baseEntry, action: 'proof.submit' });
      logAudit({ ...baseEntry, action: 'user.update' });
      logAudit({ ...baseEntry, action: 'task.create' });

      await flushQueue();

      expect(mockExecuteRaw).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------
  // Regression tests for #60: scheduleFlush/drainQueue used to flip
  // `draining` back to false the instant a batch was spliced off — i.e.
  // *before* that batch's writes actually completed. An entry enqueued
  // while those writes were still in flight would see `draining === false`
  // and spin up a second, fully independent drainQueue invocation instead
  // of being folded into the one already running. Under bursty traffic
  // followed by a quiet tail (no further logAudit call to "get lucky" and
  // re-trigger a flush), that overlap was the mechanism for real audit
  // loss: concurrent, unserialized writes racing each other and, on the
  // exhausted-retry path, some of them never landing.
  // ---------------------------------------------------------------------
  describe('concurrency: entries enqueued while a drain is in flight (#60)', () => {
    it('never has two writes in flight at once — an entry enqueued mid-drain must wait for the current write, not start a second overlapping drainQueue', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const resolvers: Array<() => void> = [];

      mockExecuteRaw.mockImplementation(() => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          resolvers.push(() => {
            inFlight -= 1;
            resolve(1);
          });
        });
      });

      logAudit({ ...baseEntry, action: 'first' });

      // Let the setImmediate fire so drainQueue starts its first write. That
      // write is now suspended on an unresolved promise (resolvers[0]).
      jest.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();

      expect(resolvers).toHaveLength(1);
      expect(maxInFlight).toBe(1);

      // A second entry arrives — e.g. a concurrent request's audit call —
      // while the first write is still pending. This is the quiet tail:
      // no further logAudit call happens after this one.
      logAudit({ ...baseEntry, action: 'second' });

      // Give any (buggy) newly-scheduled setImmediate every chance to fire
      // before the first write resolves.
      jest.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();

      // The queue must serialize writes: 'second' must not start until
      // 'first' has finished, so at most one write is ever in flight.
      expect(maxInFlight).toBe(1);
      expect(resolvers).toHaveLength(1);

      // Let 'second' resolve immediately once it starts, then finish 'first'
      // and let the drain loop pick 'second' up on its own — no further
      // logAudit call arrives (the quiet tail).
      mockExecuteRaw.mockImplementation(() => Promise.resolve(1));
      resolvers[0]();
      await flushQueue();

      expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
      expect(maxInFlight).toBe(1);
    });

    it('persists 100% of entries under a burst-then-idle pattern, including one enqueued mid-write, verified against the recorded writes', async () => {
      mockExecuteRaw.mockResolvedValue(1);

      // Burst of entries with no gaps between them.
      const burstActions = ['burst-0', 'burst-1', 'burst-2', 'burst-3', 'burst-4'];
      for (const action of burstActions) {
        logAudit({ ...baseEntry, action });
      }

      // Kick off the drain and let it get partway through the burst.
      jest.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();

      // One more entry arrives mid-drain, then everything goes idle —
      // no further logAudit call follows it.
      logAudit({ ...baseEntry, action: 'late-arrival' });

      await flushQueue();

      const persistedActions = mockExecuteRaw.mock.calls.map((call) => call[2] as string);
      const expectedActions = [...burstActions, 'late-arrival'];

      expect(persistedActions.sort()).toEqual(expectedActions.sort());
      expect(mockExecuteRaw).toHaveBeenCalledTimes(expectedActions.length);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('does not surface a request-path error when the queue is under heavy concurrent load', async () => {
      mockExecuteRaw.mockResolvedValue(1);
      const total = 200;

      expect(() => {
        for (let i = 0; i < total; i++) {
          logAudit({ ...baseEntry, action: `flood-${i}` });
        }
      }).not.toThrow();

      // 200 sequential writes each need a few microtask turns to resolve;
      // loop until the drain genuinely catches up instead of a fixed tick count.
      for (let i = 0; i < total * 4 && mockExecuteRaw.mock.calls.length < total; i++) {
        jest.runAllTimers();
        await Promise.resolve();
      }

      expect(mockExecuteRaw).toHaveBeenCalledTimes(total);
    });
  });
});
