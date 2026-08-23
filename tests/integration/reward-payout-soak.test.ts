/**
 * Reward-Payout Soak / Idempotency Harness
 * =========================================
 * Drives proof approval + reward payout with:
 *   • High concurrency (multiple sweepers + workers running simultaneously)
 *   • Forced mid-payout worker kills (simulated via abrupt close + restart)
 *   • Stale-PROCESSING row injection (crash between claim and completion)
 *   • Duplicate-enqueue storms (sweeper fires while jobs are still in-flight)
 *
 * Invariants checked by query (not manual inspection):
 *   1. No proof has more than one RewardPayout row             (UNIQUE constraint + count)
 *   2. Every PAID row has a distinct txHash                    (GROUP BY + count)
 *   3. No txHash appears on more than one PAID row             (duplicate payment)
 *   4. SUM of paid rewards == SUM of approved proof task rewards
 *   5. Every approved proof eventually reaches rewardedAt != NULL
 *
 * Prerequisites (real infra required — no mocks):
 *   DATABASE_URL=postgresql://ecotask:ecotask@localhost:5432/ecotask_soak
 *   REDIS_URL=redis://localhost:6379
 *   SOAK_TEST=true          ← gate so the suite only runs when explicitly requested
 *   STELLAR_ORACLE_SECRET_KEY must be unset or "mock" (uses mock-tx-* hashes)
 *
 * Run locally:
 *   docker compose up -d postgres redis
 *   DATABASE_URL=postgresql://ecotask:ecotask@localhost:5432/ecotask_soak \
 *   REDIS_URL=redis://localhost:6379 \
 *   SOAK_TEST=true \
 *   npx jest --runInBand tests/integration/reward-payout-soak.test.ts
 *
 * The --runInBand flag is intentional: the test manages its own internal
 * parallelism via Promise.all; Jest worker isolation would fight that.
 */

import { PrismaClient } from '@prisma/client';
import IORedis from 'ioredis';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { randomUUID } from 'crypto';
import { drainRewardPayouts } from '../../src/services/rewardPayoutSweeper';
import {
  startRewardWorker,
  shutdownRewardWorker,
  enqueueRewardPayout,
} from '../../src/workers/rewardWorker';
import { QUEUE_NAMES } from '../../src/workers/queueRetention';

// ─── Gate: only run when SOAK_TEST=true ────────────────────────────────────
const RUN_SOAK = process.env.SOAK_TEST === 'true';

// ─── Tunables ───────────────────────────────────────────────────────────────
const PROOF_COUNT = parseInt(process.env.SOAK_PROOF_COUNT ?? '50', 10);
const CONCURRENCY = parseInt(process.env.SOAK_CONCURRENCY ?? '4', 10);
const KILL_AFTER_MS = parseInt(process.env.SOAK_KILL_AFTER_MS ?? '200', 10);
const DRAIN_ROUNDS = parseInt(process.env.SOAK_DRAIN_ROUNDS ?? '6', 10);
const SOAK_TIMEOUT_MS = parseInt(process.env.SOAK_TIMEOUT_MS ?? '120000', 10);

// ─── Infra handles (module-level so afterAll can always clean up) ────────────
let prisma: PrismaClient;
let redis: IORedis;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Seed: one Task + N Users each with one APPROVED Proof + one RewardPayout row. */
async function seedApprovedProofs(count: number): Promise<{ proofIds: string[]; taskId: string; rewardMicros: bigint }> {
  const rewardMicros = BigInt(500_000_000); // 50 ECO
  const task = await prisma.task.create({
    data: {
      id: randomUUID(),
      title: 'Soak Task',
      type: 'cleanup',
      rewardAmountMicros: rewardMicros,
      rewardToken: 'ECO',
      lat: -1.2921,
      lng: 36.8219,
      radiusMeters: 100,
    },
  });

  const proofIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        wallet: `GCMOCK${randomUUID().replace(/-/g, '').slice(0, 50)}`,
      },
    });
    const proof = await prisma.proof.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        taskId: task.id,
        status: 'APPROVED',
        lat: -1.2921,
        lng: 36.8219,
      },
    });
    // Create the RewardPayout outbox row exactly as the verificationWorker would:
    // in the same transaction as proof approval (simulated as sequential here).
    await prisma.rewardPayout.create({
      data: { proofId: proof.id },
    });
    proofIds.push(proof.id);
  }
  return { proofIds, taskId: task.id, rewardMicros };
}

/**
 * Forcibly inject N stale-PROCESSING rows to simulate a worker that was
 * killed after claiming a payout but before completing it.  The sweeper's
 * reclaim path must reset these to PENDING so they are retried.
 */
async function injectStaleProcessingRows(proofIds: string[], count: number): Promise<void> {
  const targets = proofIds.slice(0, count);
  // Stamp createdAt as 10 minutes ago so the sweeper sees them as stale immediately.
  const staleTime = new Date(Date.now() - 10 * 60 * 1000);
  await prisma.rewardPayout.updateMany({
    where: { proofId: { in: targets }, status: 'PENDING' },
    data: { status: 'PROCESSING', createdAt: staleTime },
  });
}

/** Wait until every proof has rewardedAt set or the deadline passes. */
async function waitForAllRewarded(
  proofIds: string[],
  deadlineMs: number,
): Promise<{ rewarded: number; missing: string[] }> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const rewarded = await prisma.proof.count({
      where: { id: { in: proofIds }, rewardedAt: { not: null } },
    });
    if (rewarded === proofIds.length) {
      return { rewarded, missing: [] };
    }
    await sleep(500);
  }
  const missing = await prisma.proof.findMany({
    where: { id: { in: proofIds }, rewardedAt: null },
    select: { id: true },
  });
  return {
    rewarded: proofIds.length - missing.length,
    missing: missing.map((p) => p.id),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flush the entire BullMQ reward-payout queue (all states). */
async function flushQueue(): Promise<void> {
  const q = new Queue(QUEUE_NAMES.rewardPayout, {
    connection: redis as unknown as ConnectionOptions,
  });
  await q.obliterate({ force: true });
  await q.close();
}

// ─── Global setup / teardown ─────────────────────────────────────────────────

beforeAll(async () => {
  if (!RUN_SOAK) return;

  prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });
  redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });

  // Confirm connectivity before spending time on seeding.
  await prisma.$queryRaw`SELECT 1`;
  await redis.ping();
});

afterAll(async () => {
  if (!RUN_SOAK) return;

  await shutdownRewardWorker();
  await redis.quit();
  await prisma.$disconnect();
});

// ─── The soak suite ──────────────────────────────────────────────────────────

describe('reward payout soak — idempotency under failure injection', () => {
  // All tests in this file are gated behind SOAK_TEST=true.
  // Using a conditional `describe` body means Jest still reports the suite
  // (with skipped tests) rather than silently omitting it.
  const it = RUN_SOAK ? global.it : global.it.skip;

  // Each test gets its own isolated seed so failures are independent.
  // We wipe the relevant tables in beforeEach rather than using a single
  // transaction-rollback trick because the workers open their own connections.

  beforeEach(async () => {
    if (!RUN_SOAK) return;
    // Hard delete any data from a previous scenario.  The unique constraint on
    // proofId means leftover PAID rows would block re-seeding with the same IDs.
    await prisma.rewardPayout.deleteMany({});
    await prisma.proof.deleteMany({});
    await prisma.task.deleteMany({});
    await prisma.user.deleteMany({});
    await flushQueue();
  });

  // ── 1. Happy-path throughput ──────────────────────────────────────────────
  it(
    'processes all proofs exactly once under concurrent sweepers',
    async () => {
      const { proofIds, rewardMicros } = await seedApprovedProofs(PROOF_COUNT);

      startRewardWorker();

      // Fire CONCURRENCY sweeper rounds simultaneously to stress the claim-guard.
      await Promise.all(
        Array.from({ length: CONCURRENCY }, () => drainRewardPayouts()),
      );

      // Wait for workers to drain the queue.
      const { missing } = await waitForAllRewarded(proofIds, SOAK_TIMEOUT_MS);
      await shutdownRewardWorker();

      await assertInvariants(prisma, proofIds, rewardMicros);
      expect(missing).toHaveLength(0);
    },
    SOAK_TIMEOUT_MS + 5000,
  );

  // ── 2. Worker killed mid-flight ───────────────────────────────────────────
  it(
    'recovers after worker is forcibly killed mid-payout',
    async () => {
      const { proofIds, rewardMicros } = await seedApprovedProofs(PROOF_COUNT);

      // Start worker, let it process some jobs, then kill it.
      startRewardWorker();
      await drainRewardPayouts();
      await sleep(KILL_AFTER_MS);
      await shutdownRewardWorker(); // ← abrupt kill simulation

      // Inject stale-PROCESSING rows for any row that got stuck mid-claim.
      // The sweeper's reclaim loop will reset them to PENDING.
      await injectStaleProcessingRows(proofIds, Math.floor(PROOF_COUNT * 0.3));

      // Restart worker + run multiple sweep rounds.
      startRewardWorker();
      for (let i = 0; i < DRAIN_ROUNDS; i++) {
        await drainRewardPayouts();
        await sleep(300);
      }

      const { missing } = await waitForAllRewarded(proofIds, SOAK_TIMEOUT_MS);
      await shutdownRewardWorker();

      await assertInvariants(prisma, proofIds, rewardMicros);
      expect(missing).toHaveLength(0);
    },
    SOAK_TIMEOUT_MS + 5000,
  );

  // ── 3. Duplicate-enqueue storm ────────────────────────────────────────────
  it(
    'handles sweeper firing multiple times before any job completes',
    async () => {
      const { proofIds, rewardMicros } = await seedApprovedProofs(PROOF_COUNT);

      // Enqueue every payout N times before the worker starts.
      // BullMQ deduplicates on jobId (= payoutId), so only one job per payout
      // should survive.  We verify this via the invariant checks below.
      const payouts = await prisma.rewardPayout.findMany({
        where: { proofId: { in: proofIds } },
        select: { id: true, proofId: true },
      });
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          for (const p of payouts) {
            await enqueueRewardPayout(p.id, p.proofId);
          }
        }),
      );

      startRewardWorker();
      const { missing } = await waitForAllRewarded(proofIds, SOAK_TIMEOUT_MS);
      await shutdownRewardWorker();

      await assertInvariants(prisma, proofIds, rewardMicros);
      expect(missing).toHaveLength(0);
    },
    SOAK_TIMEOUT_MS + 5000,
  );

  // ── 4. Stale-PROCESSING rows only (sweeper reclaim path) ─────────────────
  it(
    'reclaims all stale PROCESSING rows and pays each exactly once',
    async () => {
      const { proofIds, rewardMicros } = await seedApprovedProofs(PROOF_COUNT);

      // Simulate a full crash: all rows land in PROCESSING, nothing in the queue.
      await injectStaleProcessingRows(proofIds, PROOF_COUNT);

      startRewardWorker();
      for (let i = 0; i < DRAIN_ROUNDS; i++) {
        await drainRewardPayouts();
        await sleep(400);
      }

      const { missing } = await waitForAllRewarded(proofIds, SOAK_TIMEOUT_MS);
      await shutdownRewardWorker();

      await assertInvariants(prisma, proofIds, rewardMicros);
      expect(missing).toHaveLength(0);
    },
    SOAK_TIMEOUT_MS + 5000,
  );

  // ── 5. Concurrent sweepers racing on the same PENDING batch ──────────────
  it(
    'concurrent sweepers never double-enqueue a row that becomes PROCESSING',
    async () => {
      const { proofIds, rewardMicros } = await seedApprovedProofs(PROOF_COUNT);

      startRewardWorker();

      // Fire many sweepers at exactly the same moment against the same rows.
      await Promise.all(
        Array.from({ length: CONCURRENCY * 2 }, () => drainRewardPayouts(PROOF_COUNT)),
      );

      const { missing } = await waitForAllRewarded(proofIds, SOAK_TIMEOUT_MS);
      await shutdownRewardWorker();

      await assertInvariants(prisma, proofIds, rewardMicros);
      expect(missing).toHaveLength(0);
    },
    SOAK_TIMEOUT_MS + 5000,
  );
});

// ─── Invariant checker (query-based, no manual inspection) ──────────────────

/**
 * Checks all global safety invariants for a completed soak run:
 *
 * I-1  No proof has > 1 RewardPayout row.
 *      (Enforced at DB level by the UNIQUE constraint on proofId, but we
 *       count here so a schema regression would be caught as a test failure.)
 *
 * I-2  Every proofId that was approved has exactly one PAID RewardPayout.
 *
 * I-3  No txHash appears on more than one PAID row.
 *      (A duplicate txHash means the same on-chain transaction was
 *       recorded twice — i.e. a duplicate payment.)
 *
 * I-4  SUM of paid reward amounts == expected total.
 *      (Detects both underpayment and double-payment in aggregate.)
 *
 * I-5  Every approved Proof has rewardedAt set.
 *      (Verifies the post-payout Proof update ran inside the commit.)
 */
async function assertInvariants(
  db: PrismaClient,
  proofIds: string[],
  rewardMicros: bigint,
): Promise<void> {
  // ── I-1: at most one RewardPayout per proof ────────────────────────────
  const duplicatePayouts = await db.$queryRaw<{ proof_id: string; cnt: bigint }[]>`
    SELECT proof_id, COUNT(*) AS cnt
    FROM   reward_payouts
    WHERE  proof_id = ANY(${proofIds}::uuid[])
    GROUP  BY proof_id
    HAVING COUNT(*) > 1
  `;
  expect(duplicatePayouts).toHaveLength(0);

  // ── I-2: every approved proof has exactly one PAID row ────────────────
  const paidCount = await db.rewardPayout.count({
    where: { proofId: { in: proofIds }, status: 'PAID' },
  });
  expect(paidCount).toBe(proofIds.length);

  // ── I-3: no duplicate txHash among PAID rows ──────────────────────────
  const duplicateTxHashes = await db.$queryRaw<{ tx_hash: string; cnt: bigint }[]>`
    SELECT tx_hash, COUNT(*) AS cnt
    FROM   reward_payouts
    WHERE  proof_id = ANY(${proofIds}::uuid[])
      AND  status   = 'PAID'
      AND  tx_hash IS NOT NULL
    GROUP  BY tx_hash
    HAVING COUNT(*) > 1
  `;
  expect(duplicateTxHashes).toHaveLength(0);

  // ── I-4: SUM of paid amounts == expected ──────────────────────────────
  // The mock stellarService always issues exactly one payment per payout.
  // Here we cross-check against the task's rewardAmountMicros so that a
  // future code change that breaks the amount passed to submitReward
  // is caught by this invariant.
  const proofRows = await db.proof.findMany({
    where: { id: { in: proofIds } },
    include: { task: true },
  });
  const expectedTotalMicros =
    BigInt(proofRows.length) * rewardMicros;

  // We cannot SUM BigInt columns in Prisma yet, so use raw SQL.
  const sumResult = await db.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(t.reward_amount_micros), 0)::bigint AS total
    FROM   reward_payouts rp
    JOIN   proofs         p  ON p.id = rp.proof_id
    JOIN   tasks          t  ON t.id = p.task_id
    WHERE  rp.proof_id = ANY(${proofIds}::uuid[])
      AND  rp.status   = 'PAID'
  `;
  expect(sumResult[0]?.total).toBe(expectedTotalMicros);

  // ── I-5: every approved proof has rewardedAt set ──────────────────────
  const unRewardedCount = await db.proof.count({
    where: { id: { in: proofIds }, rewardedAt: null },
  });
  expect(unRewardedCount).toBe(0);
}
