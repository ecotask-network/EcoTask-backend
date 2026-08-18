/**
 * DB-backed verification for issue #17 (hot-path indexes).
 *
 * Requires a reachable PostgreSQL (CI provides one via the workflow's
 * `postgres` service after `prisma migrate deploy`). When no database is
 * reachable the suite skips with a warning instead of failing, so `npm test`
 * stays green on machines without the docker stack.
 *
 * The queries under test are the exact shapes emitted by the application
 * code (see src/controllers/proofController.ts listPendingProofs,
 * src/services/verificationService.ts autoVerify, src/services/auditService.ts
 * getAuditLogs, src/controllers/taskClaimController.ts getTaskClaims, and
 * src/models/user.ts getUserImpact).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const RUN = `idx-test-${Date.now()}`;
const USERS = 50;
const TASKS = 20;
const PROOFS = 8000;

let dbAvailable = false;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    console.warn(
      '[index-verification] database unavailable — skipping suite (start Postgres and re-run)',
    );
  }
});

afterAll(async () => {
  if (dbAvailable) {
    // Remove only this run's rows, in FK-safe order.
    await prisma.$executeRawUnsafe(`DELETE FROM "proof_photos" WHERE id LIKE '${RUN}-%'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "verifications" WHERE id LIKE '${RUN}-%'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "proofs" WHERE id LIKE '${RUN}-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "task_claims" WHERE id LIKE '${RUN}-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id LIKE '${RUN}-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "tasks" WHERE id LIKE '${RUN}-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE '${RUN}-%'`);
  }
  await prisma.$disconnect();
});

async function seed(): Promise<void> {
  const users = Array.from({ length: USERS }, (_, i) => ({
    id: `${RUN}-u-${i + 1}`,
    wallet: `${RUN}-wallet-${i + 1}`,
    name: `User ${i + 1}`,
    role: 'user',
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  for (let i = 0; i < users.length; i += 50) {
    await prisma.user.createMany({ data: users.slice(i, i + 50) });
  }

  const tasks = Array.from({ length: TASKS }, (_, i) => ({
    id: `${RUN}-t-${i + 1}`,
    title: `Task ${i + 1}`,
    type: ['cleanup', 'planting', 'recycling'][i % 3],
    rewardAmountMicros: 500000000n,
    lat: -1.2921,
    lng: 36.8219,
    radiusMeters: 100,
    status: 'ACTIVE',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 86400000),
  }));
  await prisma.task.createMany({ data: tasks });

  // 70% APPROVED / 20% REJECTED / 7% PENDING / 3% VERIFYING — a realistic
  // admin queue is a small fraction of all proofs.
  const statuses = [
    ...Array(70).fill('APPROVED'),
    ...Array(20).fill('REJECTED'),
    ...Array(7).fill('PENDING'),
    ...Array(3).fill('VERIFYING'),
  ];
  for (let batch = 0; batch < PROOFS / 1000; batch += 1) {
    const proofs = Array.from({ length: 1000 }, (_, j) => {
      const n = batch * 1000 + j;
      return {
        id: `${RUN}-p-${n + 1}`,
        userId: `${RUN}-u-${(n % USERS) + 1}`,
        taskId: `${RUN}-t-${(n % TASKS) + 1}`,
        status: statuses[n % statuses.length],
        lat: -1.29,
        lng: 36.82,
        createdAt: new Date(Date.now() - (n % 60) * 86400000),
        updatedAt: new Date(),
      };
    });
    await prisma.proof.createMany({ data: proofs });
  }

  // One photo per proof (unique sha256).
  const photos = Array.from({ length: PROOFS }, (_, i) => ({
    id: `${RUN}-ph-${i + 1}`,
    proofId: `${RUN}-p-${i + 1}`,
    cid: `${RUN}-cid-${i + 1}`,
    filename: 'p.jpg',
    sha256: `idxhash-${i + 1}`,
    width: 1000,
    height: 800,
  }));
  for (let i = 0; i < photos.length; i += 1000) {
    await prisma.proofPhoto.createMany({ data: photos.slice(i, i + 1000) });
  }

  const verifications = Array.from({ length: 2000 }, (_, i) => ({
    id: `${RUN}-v-${i + 1}`,
    proofId: `${RUN}-p-${(i % PROOFS) + 1}`,
    verifierId: `${RUN}-u-${(i % USERS) + 1}`,
    verdict: 'approved',
    createdAt: new Date(),
  }));
  for (let i = 0; i < verifications.length; i += 1000) {
    await prisma.verification.createMany({ data: verifications.slice(i, i + 1000) });
  }

  // Every (task, user) pair once — the schema's @@unique cap.
  const claims = Array.from({ length: USERS * TASKS }, (_, i) => ({
    id: `${RUN}-c-${i + 1}`,
    userId: `${RUN}-u-${(i % USERS) + 1}`,
    taskId: `${RUN}-t-${Math.floor(i / USERS) + 1}`,
    status: i % 2 === 0 ? 'active' : 'expired',
    claimedAt: new Date(),
    expiresAt:
      i % 2 === 0 ? new Date(Date.now() + 86400000) : new Date(Date.now() - 86400000),
  }));
  for (let i = 0; i < claims.length; i += 1000) {
    await prisma.taskClaim.createMany({ data: claims.slice(i, i + 1000) });
  }

  const auditLogs = Array.from({ length: 5000 }, (_, i) => ({
    id: `${RUN}-a-${i + 1}`,
    userId: i % 10 === 0 ? null : `${RUN}-u-${(i % USERS) + 1}`,
    action: `action-${i % 5}`,
    resource: ['task', 'proof', 'user', 'auth'][i % 4],
    resourceId: `${RUN}-res-${i + 1}`,
    details: {},
    outcome: 'SUCCESS',
    statusCode: 200,
    durationMs: 5,
    createdAt: new Date(Date.now() - (i % 60) * 86400000),
  }));
  for (let i = 0; i < auditLogs.length; i += 1000) {
    await prisma.auditLog.createMany({ data: auditLogs.slice(i, i + 1000) });
  }

  // Fresh statistics so the planner's estimates reflect the seeded volumes.
  await prisma.$executeRawUnsafe(
    'ANALYZE "proofs", "proof_photos", "verifications", "task_claims", "AuditLog", "tasks", "User"',
  );
}

interface PlanShape {
  indexScan: boolean;
  seqScanOnHotTable: boolean;
}

async function explain(sql: string, hotTable: string): Promise<PlanShape> {
  const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': unknown[] }>>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
  );
  const plan = (rows[0]['QUERY PLAN'][0] as { Plan: Record<string, unknown> }).Plan;
  const nodes: Array<Record<string, unknown>> = [];
  const walk = (node: Record<string, unknown>): void => {
    nodes.push(node);
    const children = node.Plans as Array<Record<string, unknown>> | undefined;
    (children ?? []).forEach(walk);
  };
  walk(plan);
  return {
    indexScan: nodes.some((n) =>
      /^(Index Scan|Index Only Scan|Bitmap Index Scan)/.test(String(n['Node Type'])),
    ),
    seqScanOnHotTable: nodes.some(
      (n) => n['Node Type'] === 'Seq Scan' && String(n['Relation Name']) === hotTable,
    ),
  };
}

describe('Issue #17: hot-path indexes', () => {
  beforeAll(async () => {
    if (dbAvailable) await seed();
  });

  it('creates the expected index set (and drops the redundant sha256 index)', async () => {
    if (!dbAvailable) return;
    const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(rows.map((r) => r.indexname));
    for (const expected of [
      'proofs_status_created_at_idx',
      'proofs_task_id_status_idx',
      'proofs_user_id_status_idx',
      'proof_photos_proof_id_idx',
      'proof_photos_sha256_proof_id_idx',
      'proof_photos_sha256_key',
      'verifications_proof_id_idx',
      'task_claims_task_id_status_idx',
      'AuditLog_userId_resource_createdAt_idx',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
    // The non-unique sha256 index duplicated the unique key; it must be gone.
    expect(names.has('proof_photos_sha256_idx')).toBe(false);
  });

  it('listPendingProofs plan uses the status+created_at index (no seq scan)', async () => {
    if (!dbAvailable) return;
    const { indexScan, seqScanOnHotTable } = await explain(
      `SELECT id, status, created_at FROM proofs WHERE status IN ('PENDING','VERIFYING') ORDER BY created_at ASC LIMIT 50`,
      'proofs',
    );
    expect(indexScan).toBe(true);
    expect(seqScanOnHotTable).toBe(false);
  });

  it('submitProof duplicate-photo check plan uses an index (no seq scan)', async () => {
    if (!dbAvailable) return;
    const { indexScan, seqScanOnHotTable } = await explain(
      `SELECT COUNT(*) FROM proof_photos WHERE sha256 IN ('idxhash-1') AND proof_id <> '${RUN}-p-9999'`,
      'proof_photos',
    );
    expect(indexScan).toBe(true);
    expect(seqScanOnHotTable).toBe(false);
  });

  it('getAuditLogs with userId+resource filters uses the composite index (no seq scan)', async () => {
    if (!dbAvailable) return;
    const { indexScan, seqScanOnHotTable } = await explain(
      `SELECT * FROM "AuditLog" WHERE "userId" = '${RUN}-u-1' AND resource = 'task' ORDER BY "createdAt" DESC LIMIT 50 OFFSET 0`,
      'AuditLog',
    );
    expect(indexScan).toBe(true);
    expect(seqScanOnHotTable).toBe(false);
  });

  it('getTaskClaims plan uses the task_id+status index (no seq scan)', async () => {
    if (!dbAvailable) return;
    const { indexScan, seqScanOnHotTable } = await explain(
      `SELECT c.id FROM task_claims c WHERE c.task_id = '${RUN}-t-1' AND c.status = 'active' AND c.expires_at > now()`,
      'task_claims',
    );
    expect(indexScan).toBe(true);
    expect(seqScanOnHotTable).toBe(false);
  });

  it('getUserImpact plan uses the user_id+status index (no seq scan)', async () => {
    if (!dbAvailable) return;
    const { indexScan, seqScanOnHotTable } = await explain(
      `SELECT t.type, COUNT(*) FROM proofs p JOIN tasks t ON p.task_id = t.id WHERE p.user_id = '${RUN}-u-1' AND p.status = 'APPROVED' GROUP BY t.type`,
      'proofs',
    );
    expect(indexScan).toBe(true);
    expect(seqScanOnHotTable).toBe(false);
  });
});
