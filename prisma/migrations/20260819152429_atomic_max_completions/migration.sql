-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "completed_count" INTEGER NOT NULL DEFAULT 0;


-- Backfill: existing tasks should start with their actual approved-proof
-- count, not 0, so in-flight tasks aren't under-counted going forward.
UPDATE "tasks" t
SET "completed_count" = (
  SELECT COUNT(*) FROM "proofs" p
  WHERE p."task_id" = t.id AND p.status = 'APPROVED'
);
