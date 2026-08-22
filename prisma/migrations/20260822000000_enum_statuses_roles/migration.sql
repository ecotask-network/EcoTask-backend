-- Rollback path (manual): restore the TEXT columns and drop the enums.
--   ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
--   ALTER TABLE "User" ALTER COLUMN "role" TYPE TEXT USING ("role"::text);
--   ALTER TABLE "tasks" ALTER COLUMN "status" DROP DEFAULT;
--   ALTER TABLE "tasks" ALTER COLUMN "status" TYPE TEXT USING ("status"::text);
--   ALTER TABLE "task_claims" ALTER COLUMN "status" DROP DEFAULT;
--   ALTER TABLE "task_claims" ALTER COLUMN "status" TYPE TEXT USING ("status"::text);
--   DROP TYPE "UserRole"; DROP TYPE "TaskStatus"; DROP TYPE "ClaimStatus";

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED');
CREATE TYPE "ClaimStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED');
CREATE TYPE "UserRole" AS ENUM ('USER', 'VALIDATOR', 'ADMIN');

-- Data cleaning: normalize any legacy lowercase values to the canonical
-- uppercase enum values before casting the columns.
UPDATE "User" SET "role" = 'USER' WHERE "role" = 'user';
UPDATE "User" SET "role" = 'VALIDATOR' WHERE "role" = 'validator';
UPDATE "User" SET "role" = 'ADMIN' WHERE "role" = 'admin';

UPDATE "tasks" SET "status" = 'ACTIVE' WHERE "status" = 'active';
UPDATE "tasks" SET "status" = 'COMPLETED' WHERE "status" = 'completed';
UPDATE "tasks" SET "status" = 'EXPIRED' WHERE "status" = 'expired';

UPDATE "task_claims" SET "status" = 'ACTIVE' WHERE "status" = 'active';
UPDATE "task_claims" SET "status" = 'RELEASED' WHERE "status" = 'released';
UPDATE "task_claims" SET "status" = 'EXPIRED' WHERE "status" = 'expired';

-- Migration-time assertion: fail loudly if any out-of-enum value remains so
-- invalid states are never silently coerced.
DO $$
DECLARE
  v_task  TEXT;
  v_claim TEXT;
  v_role  TEXT;
BEGIN
  SELECT "status" INTO v_task FROM "tasks"
    WHERE "status" NOT IN ('ACTIVE', 'COMPLETED', 'EXPIRED') LIMIT 1;
  IF v_task IS NOT NULL THEN
    RAISE EXCEPTION 'tasks.status contains out-of-enum value ''%''; clean data before migrating', v_task;
  END IF;

  SELECT "status" INTO v_claim FROM "task_claims"
    WHERE "status" NOT IN ('ACTIVE', 'RELEASED', 'EXPIRED') LIMIT 1;
  IF v_claim IS NOT NULL THEN
    RAISE EXCEPTION 'task_claims.status contains out-of-enum value ''%''; clean data before migrating', v_claim;
  END IF;

  SELECT "role" INTO v_role FROM "User"
    WHERE "role" NOT IN ('USER', 'VALIDATOR', 'ADMIN') LIMIT 1;
  IF v_role IS NOT NULL THEN
    RAISE EXCEPTION 'User.role contains out-of-enum value ''%''; clean data before migrating', v_role;
  END IF;
END $$;

-- Convert columns to enum types.
ALTER TABLE "User" ALTER COLUMN "role" SET DATA TYPE "UserRole" USING ("role"::text)::"UserRole";
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER';

ALTER TABLE "tasks" ALTER COLUMN "status" SET DATA TYPE "TaskStatus" USING ("status"::text)::"TaskStatus";
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

ALTER TABLE "task_claims" ALTER COLUMN "status" SET DATA TYPE "ClaimStatus" USING ("status"::text)::"ClaimStatus";
ALTER TABLE "task_claims" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';