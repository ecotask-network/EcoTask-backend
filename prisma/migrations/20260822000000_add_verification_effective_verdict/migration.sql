-- Migration: add effective_verdict column to verifications
--
-- `verdict` stores the human/AI intent ("approved", "rejected", "inconclusive").
-- `effective_verdict` stores what was actually applied to the Proof and always
-- matches the resulting Proof.status in lower-case. The two diverge only when a
-- capacity-check overrides an "approved" auto/human verdict and the Proof ends
-- up REJECTED ("capacity_rejected").
--
-- Backfill note: existing rows where verdict = 'approved' but the proof was
-- ultimately REJECTED due to capacity cannot be identified retrospectively
-- (there is no audit trail linking them). We conservatively set
-- effective_verdict = verdict for all existing rows. This means any
-- pre-migration capacity-rejected rows remain inconsistent in this column, but
-- all rows created after this migration will be correct. A comment in the data
-- dictionary documents this known limitation.

-- Step 1: add the column as nullable so existing rows are not rejected.
ALTER TABLE "verifications" ADD COLUMN "effective_verdict" TEXT;

-- Step 2: backfill — use `verdict` as the best available approximation.
UPDATE "verifications" SET "effective_verdict" = "verdict";

-- Step 3: tighten to NOT NULL now that every row has a value.
ALTER TABLE "verifications" ALTER COLUMN "effective_verdict" SET NOT NULL;
