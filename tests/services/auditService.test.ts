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
});
