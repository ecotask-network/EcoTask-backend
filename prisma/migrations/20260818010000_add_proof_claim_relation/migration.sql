-- Tie each proof to the TaskClaim it was submitted under (issue #18).
-- Nullable: proofs created before claims were enforced are grandfathered
-- (claim_id stays NULL) rather than retroactively invalidated. New proofs
-- must reference a valid, unexpired claim — enforced in submitProof within
-- a transaction.
--
-- AlterTable
ALTER TABLE "proofs" ADD COLUMN "claim_id" TEXT;

-- AddForeignKey (Prisma default for an optional relation)
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "task_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: reconcile dangling claims — rows the expiry sweeper has not yet
-- reached (status 'active' but expires_at in the past) are marked 'expired'
-- so claim/submit-time enforcement sees them as expired immediately.
UPDATE "task_claims" SET status = 'expired'
WHERE status = 'active' AND "expires_at" < NOW();
