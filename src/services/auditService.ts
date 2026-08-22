import prisma from '../utils/prisma.js';
import logger from '../utils/logger.js';

export type AuditOutcome = 'SUCCESS' | 'FAILURE';

export interface AuditLogEntry {
  userId?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  outcome?: AuditOutcome;
  statusCode?: number;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Write-through queue with retry
//
// The queue is an in-process array drained by a single long-running loop.
// `draining` stays true for the *entire* drain session — not just while a
// batch is being spliced off — so at most one drainQueue loop is ever
// running. Entries enqueued while a write is in flight are simply picked up
// by the loop re-checking the queue before it gives up, instead of spawning
// a second, overlapping drainQueue invocation (which used to let two writes
// race each other and could leave a quiet-tail entry with no flush ever
// scheduled for it). Each entry is attempted up to MAX_ATTEMPTS times with
// exponential back-off. On final exhaustion a logger.error alert is raised
// so the failure is never silently dropped.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

interface QueueItem {
  entry: AuditLogEntry;
  attempts: number;
}

const queue: QueueItem[] = [];
let draining = false;

function scheduleFlush(): void {
  if (!draining) {
    draining = true;
    setImmediate(drainQueue);
  }
}

async function drainQueue(): Promise<void> {
  // Keep looping — and keep `draining` true — until the queue is confirmed
  // empty. Anything pushed while the previous batch's writes were in flight
  // is caught by re-checking queue.length rather than relying on a new
  // logAudit call to schedule another cycle.
  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length);

    for (const item of batch) {
      await writeWithRetry(item);
    }
  }

  draining = false;
}

async function writeWithRetry(item: QueueItem): Promise<void> {
  item.attempts += 1;

  try {
    await prisma.$executeRaw`
      INSERT INTO "AuditLog" (
        id, "userId", action, resource, "resourceId", details, ip,
        outcome, "statusCode", "durationMs", "createdAt"
      ) VALUES (
        gen_random_uuid(),
        ${item.entry.userId ?? null},
        ${item.entry.action},
        ${item.entry.resource},
        ${item.entry.resourceId ?? null},
        ${JSON.stringify(item.entry.details ?? {})}::jsonb,
        ${item.entry.ip ?? null},
        ${item.entry.outcome ?? null},
        ${item.entry.statusCode ?? null},
        ${item.entry.durationMs ?? null},
        NOW()
      )
    `;
  } catch (err) {
    if (item.attempts < MAX_ATTEMPTS) {
      const delayMs = BASE_DELAY_MS * 2 ** (item.attempts - 1);
      logger.warn('Audit write failed, will retry', {
        attempt: item.attempts,
        maxAttempts: MAX_ATTEMPTS,
        retryAfterMs: delayMs,
        action: item.entry.action,
        err,
      });
      await sleep(delayMs);
      return writeWithRetry(item);
    }

    // All retries exhausted — raise a visible alert. Never drop silently.
    logger.error('Audit write permanently failed after max retries — audit record lost', {
      attempts: item.attempts,
      action: item.entry.action,
      resource: item.entry.resource,
      resourceId: item.entry.resourceId,
      userId: item.entry.userId,
      outcome: item.entry.outcome,
      err,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enqueue an audit log entry. The write happens asynchronously via the
 * internal queue but is never fire-and-forget: failures are retried and
 * ultimately alert via logger.error rather than being swallowed.
 */
export function logAudit(entry: AuditLogEntry): void {
  queue.push({ entry, attempts: 0 });
  scheduleFlush();
}

// ---------------------------------------------------------------------------
// Query helpers (used by the admin audit route)
// ---------------------------------------------------------------------------

export async function getAuditLogs(params: {
  userId?: string;
  resource?: string;
  resourceId?: string;
  limit?: number;
  offset?: number;
}) {
  const where: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (params.userId) {
    where.push(`"userId" = $${paramIndex++}`);
    values.push(params.userId);
  }
  if (params.resource) {
    where.push(`resource = $${paramIndex++}`);
    values.push(params.resource);
  }
  if (params.resourceId) {
    where.push(`"resourceId" = $${paramIndex++}`);
    values.push(params.resourceId);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const query = `SELECT * FROM "AuditLog" ${whereClause} ORDER BY "createdAt" DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  const countQuery = `SELECT COUNT(*) FROM "AuditLog" ${whereClause}`;

  const [logs, countResult] = await Promise.all([
    prisma.$queryRawUnsafe(query, ...values, limit, offset),
    prisma.$queryRawUnsafe(countQuery, ...values),
  ]);

  return {
    data: logs,
    meta: {
      total: Number((countResult as Array<{ count: bigint }>)[0]?.count ?? 0),
      limit,
      offset,
    },
  };
}
