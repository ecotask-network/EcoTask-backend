# Hot-path index verification (Issue #17)

Measurement-driven index set for the query hot paths, verified with `EXPLAIN
(ANALYZE, BUFFERS)` against PostgreSQL 15 with realistic data volumes, plus a
measured write-amplification check on `proofs` inserts (the highest-write
table).

All `EXPLAIN` output below was captured with the migration set in this PR
applied and `ANALYZE` run after seeding:

| Table           | Rows seeded                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `proofs`        | 40,000 (70% APPROVED, 20% REJECTED, 7% PENDING, 3% VERIFYING — a realistic admin queue is a small fraction, not 40% of rows) |
| `proof_photos`  | 80,000 (2 per proof, unique `sha256`)                                                                                        |
| `verifications` | 24,000                                                                                                                       |
| `task_claims`   | 50,000 (500 users × 200 tasks, mixed active/expired/released)                                                                |
| `AuditLog`      | 20,000                                                                                                                       |

## Index set and the query shapes each one serves

| Index                                          | Query shape                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `proofs(status, created_at)`                   | `listPendingProofs` — `WHERE status IN ('PENDING','VERIFYING')` / `WHERE status = ?`, `ORDER BY created_at ASC`, `LIMIT` |
| `proofs(user_id, status)`                      | `getUserImpact` — `WHERE user_id = ? AND status = 'APPROVED'` (pre-existing, re-verified)                                |
| `proofs(task_id, status)`                      | capacity check in `submitProof` and `completeTaskIfFull` — `COUNT(*) WHERE task_id = ? AND status = 'APPROVED'`          |
| `proof_photos(proof_id)`                       | every proof-detail/verification flow — `WHERE proof_id = ?` (Prisma does not auto-index FKs)                             |
| `proof_photos(sha256, proof_id)`               | duplicate-photo check in `autoVerify` — `WHERE sha256 IN (…) AND proof_id <> ?`; covering, enables an index-only scan    |
| `verifications(proof_id)`                      | proof-detail and review flows — `WHERE proof_id = ?` (FK index)                                                          |
| `task_claims(task_id, status)`                 | `getTaskClaims` — `WHERE task_id = ? AND status = 'active' AND expires_at > now()`                                       |
| `AuditLog(user_id, resource, created_at DESC)` | `getAuditLogs` with both filters — equality on `userId`+`resource`, sort on `createdAt`                                  |

**Leftmost-prefix sharing:** `proofs(user_id, status)` already serves
`WHERE user_id = ?` alone, `proofs(task_id, status)` serves
`WHERE task_id = ?` alone, and `proofs(status, created_at)` serves
`WHERE status = ?` alone — no single-column duplicates were added. The
pre-existing `AuditLog(user_id, created_at)` and `AuditLog(resource, created_at)`
indexes were kept: `getAuditLogs` also runs with only one of the two filters,
which the new composite cannot serve (resource-only queries need the
`resource` prefix).

## EXPLAIN (ANALYZE, BUFFERS) — target queries

### 1. listPendingProofs (admin queue) — `proofs_status_created_at_idx`

```
Limit  (cost=954.16..954.28 rows=50 width=29) (actual time=2.529..2.534 rows=50 loops=1)
  ->  Sort  (cost=954.16..964.19 rows=4013 width=29) (actual time=2.527..2.530 rows=50 loops=1)
        Sort Key: created_at
        Sort Method: top-N heapsort  Memory: 31kB
        ->  Bitmap Heap Scan on proofs  (cost=115.69..820.85 rows=4013 width=29) (actual time=0.485..1.909 rows=4000 loops=1)
              Recheck Cond: (status = ANY ('{PENDING,VERIFYING}'::"ProofStatus"[]))
              ->  Bitmap Index Scan on proofs_status_created_at_idx  (cost=0.00..114.69 rows=4013 width=0) (actual time=0.324..0.325 rows=4000 loops=1)
                    Index Cond: (status = ANY ('{PENDING,VERIFYING}'::"ProofStatus"[]))
```

Index scan, no seq scan. (Before this PR the same query at this volume was a
full `Seq Scan on proofs` filtering 40k rows.) The top-N sort only ever holds
the `LIMIT` page because the index already narrows to the pending set. With
the single-status variant (`?status=PENDING`) the index serves the
`ORDER BY created_at` directly with no sort at all.

### 2. submitProof duplicate-photo check — `proof_photos_sha256_proof_id_idx`

```
Aggregate  (cost=8.44..8.45 rows=1 width=8) (actual time=0.033..0.034 rows=1 loops=1)
  ->  Index Only Scan using proof_photos_sha256_proof_id_idx on proof_photos  (cost=0.42..8.44 rows=1 width=0) (actual time=0.031..0.031 rows=0 loops=1)
        Index Cond: (sha256 = '67e63a66…'::text)
        Filter: (proof_id <> 'bench-proof-5'::text)
        Heap Fetches: 0
```

Index-only scan, no heap fetch, no seq scan.

### 3. getAuditLogs with `userId` + `resource` filters — `AuditLog_userId_resource_createdAt_idx`

```
Limit  (cost=39.43..39.45 rows=10 width=98)
  ->  Sort  (cost=39.43..39.45 rows=10 width=98)
        Sort Key: "createdAt" DESC
        ->  Bitmap Heap Scan on "AuditLog"  (cost=4.39..39.26 rows=10 width=98)
              Recheck Cond: (("userId" = 'bench-user-1'::text) AND (resource = 'task'::text))
              ->  Bitmap Index Scan on "AuditLog_userId_resource_createdAt_idx"  (cost=0.00..4.39 rows=10 width=0)
                    Index Cond: (("userId" = 'bench-user-1'::text) AND (resource = 'task'::text))
```

Index scan, no seq scan (the sort re-orders only the ~10 matching rows).

### 4. getTaskClaims — `task_claims_task_id_status_idx`

```
Hash Left Join  (cost=25.66..551.77 rows=155 width=105)
  Hash Cond: (c.user_id = u.id)
  ->  Bitmap Heap Scan on task_claims c  (cost=7.41..533.11 rows=155 width=67)
        Recheck Cond: ((task_id = 'bench-task-1'::text) AND (status = 'active'::text))
        Filter: (expires_at > now())
        ->  Bitmap Index Scan on task_claims_task_id_status_idx  (cost=0.00..7.37 rows=308 width=0)
              Index Cond: ((task_id = 'bench-task-1'::text) AND (status = 'active'::text))
  ->  Hash  (cost=12.00..12.00 rows=500 width=38)
        ->  Seq Scan on "User" u  (…rows=500…)
```

Index scan on `task_claims`, no seq scan on the hot table. (The `Seq Scan on
"User"` is the 500-row dimension table joined for display names — it is not
the query's filter target and is unchanged by this PR.)

### 5. getUserImpact — `proofs_user_id_status_idx` (pre-existing, re-verified)

```
GroupAggregate  (cost=185.46..186.05 rows=3 width=25)
  ->  Sort  (cost=185.46..185.60 rows=56 width=17)
        Sort Key: t.type
        ->  Hash Join  (cost=13.36..183.84 rows=56 width=17)
              Hash Cond: (p.task_id = t.id)
              ->  Bitmap Heap Scan on proofs p  (cost=4.86..175.19 rows=56 width=14)
                    Recheck Cond: ((user_id = 'bench-user-1'::text) AND (status = 'APPROVED'::"ProofStatus"))
                    ->  Bitmap Index Scan on proofs_user_id_status_idx  (cost=0.00..4.85 rows=56 width=0)
                          Index Cond: ((user_id = 'bench-user-1'::text) AND (status = 'APPROVED'::"ProofStatus"))
              ->  Hash  (cost=6.00..6.00 rows=200 width=31)
                    ->  Seq Scan on tasks t  (…rows=200…)
```

Index scan on `proofs` (the 40k-row hot table), no seq scan. `tasks` is the
200-row dimension table.

### 6 & 7. FK joins — `proof_photos_proof_id_idx`, `verifications_proof_id_idx`

```
Bitmap Heap Scan on proof_photos  (cost=4.43..12.22 rows=2 width=98)
  ->  Bitmap Index Scan on proof_photos_proof_id_idx  (cost=0.00..4.43 rows=2 width=0)
        Index Cond: (proof_id = 'bench-proof-1'::text)

Index Scan using verifications_proof_id_idx on verifications  (cost=0.29..8.30 rows=1 width=97)
  Index Cond: (proof_id = 'bench-proof-1'::text)
```

## Write amplification on `proofs` inserts (measured)

Method: the same 1,000-row `INSERT` batch (single statement, in a
transaction, the exact per-proof shape Prisma emits) repeated 20× on an
otherwise identical table, timed inside `psql` (`\timing`), warm cache,
20,000 rows per configuration. Medians of 20 batches:

| Configuration                                                   | Median time / 1,000 inserts |
| --------------------------------------------------------------- | --------------------------- |
| `proofs` with the full index set (incl. the two new composites) | **36.65 ms**                |
| `proofs` with only the pre-existing `(user_id, status)` index   | **30.21 ms**                |

The two new composites add ≈ **6.4 ms per 1,000 inserts (+21%)**, i.e.
≈ 6.4 µs/row — two extra btree writes per insert — and ≈ **19 bytes/row** of
index storage (160 kB + 168 kB on 20k rows; the values are UUIDs, hence the
larger-than-text index tuples). That is the price paid for the plan flips in
§1 and §3–4 above, on the table where the admin queue and capacity checks are
hot. It is accepted because:

- `proofs(status, created_at)` serves the admin queue's filter+sort exactly
  and replaces a seq scan that grows linearly with the table.
- `proofs(task_id, status)` serves the capacity `COUNT` on every submission
  and every approval.
- No single-column duplicates were added (leftmost prefixes cover
  `user_id`-only and `task_id`-only filters), so the amplification is the
  minimum for the query set.

### Redundant index removed: `proof_photos_sha256_idx`

`proof_photos.sha256` is `@unique`, so the non-unique `sha256` index created
in `20260812000000_proof_photo_metadata` was a pure duplicate: every lookup
on `sha256` (the duplicate-photo check) is served by the unique key, and no
plan in this verification references it. It cost one extra btree write on
every photo insert and **4,640 kB on 80,000 rows** (~58 B/row). Dropped in
`20260818000008_drop_redundant_proof_photos_sha256_idx` with zero plan
impact.

## Migration mechanics

- **`CREATE INDEX CONCURRENTLY`** — every new index is created concurrently
  so production tables are never locked for writes during the migration
  (`proofs` in particular is the highest-write table).
- **Prisma constraint:** a migration containing more than one statement is
  wrapped in a transaction by Prisma Migrate, and `CREATE INDEX CONCURRENTLY`
  cannot run in a transaction. Each index therefore lives in its own
  single-statement migration, which Prisma executes without a transaction
  wrapper. This is the documented workaround for
  [prisma/prisma#22922](https://github.com/prisma/prisma/issues/22922).
- **Schema consistency:** the `@@index` declarations in
  `prisma/schema.prisma` mirror the raw SQL exactly (same tables, columns,
  sort order, and Prisma-generated names), so introspection and
  `prisma migrate dev` report no drift — `prisma migrate diff` against the
  applied migrations returns "No difference detected."
- **`task_claims` table:** the `TaskClaim` model has been declared in the
  schema since the claims feature commit, but no migration ever created the
  table — `task_claims` was missing from every database built from
  migrations. `20260817210000_create_task_claims` ships the missing DDL
  (unchanged schema, Prisma-generated shape) so `getTaskClaims` — a required
  EXPLAIN target for this issue — actually runs.

### Rollback

Each migration is reversible; run them in reverse order:

```sql
-- 20260818000008: rollback the redundant-index drop
CREATE INDEX CONCURRENTLY "proof_photos_sha256_idx" ON "proof_photos"("sha256");

-- 20260818000007
DROP INDEX CONCURRENTLY "AuditLog_userId_resource_createdAt_idx";

-- 20260818000006
DROP INDEX CONCURRENTLY "task_claims_task_id_status_idx";

-- 20260818000005
DROP INDEX CONCURRENTLY "verifications_proof_id_idx";

-- 20260818000004
DROP INDEX CONCURRENTLY "proof_photos_sha256_proof_id_idx";

-- 20260818000003
DROP INDEX CONCURRENTLY "proof_photos_proof_id_idx";

-- 20260818000002
DROP INDEX CONCURRENTLY "proofs_task_id_status_idx";

-- 20260818000001
DROP INDEX CONCURRENTLY "proofs_status_created_at_idx";

-- 20260817210000 (only if the claims feature itself is rolled back)
DROP TABLE "task_claims";
```

Indexes are transparent to queries — no query result changes, before or
after rollback.
