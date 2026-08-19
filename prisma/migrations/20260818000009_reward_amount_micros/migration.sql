-- Add the new column (nullable initially to populate data)
ALTER TABLE "tasks" ADD COLUMN "reward_amount_micros" BIGINT;

-- Migrate existing data
UPDATE "tasks" SET "reward_amount_micros" = CAST("reward_amount" * 10000000 AS BIGINT);

-- Make it non-nullable
ALTER TABLE "tasks" ALTER COLUMN "reward_amount_micros" SET NOT NULL;

-- Drop old column
ALTER TABLE "tasks" DROP COLUMN "reward_amount";
