-- listPendingProofs: WHERE status IN (PENDING, VERIFYING) ORDER BY created_at ASC
-- Created CONCURRENTLY (single statement, so Prisma Migrate does not wrap it in a
-- transaction) to avoid blocking writes on the highest-write table.
CREATE INDEX CONCURRENTLY "proofs_status_created_at_idx" ON "proofs"("status", "created_at");
