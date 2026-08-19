-- The TaskClaim model has been declared in prisma/schema.prisma since the
-- claims feature commit (feat(claims): add task claiming/reservation with
-- expiration and release), but no migration was ever generated for it, so
-- the table has been missing from every database built from migrations
-- (claim endpoints fail with "relation task_claims does not exist").
-- This restores schema↔database consistency; the schema was never changed
-- for this migration, only the missing DDL is being shipped.
--
-- CreateTable task_claims
CREATE TABLE "task_claims" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (matching @@unique([taskId, userId]) in the schema)
CREATE UNIQUE INDEX "task_claims_task_id_user_id_key" ON "task_claims"("task_id", "user_id");

-- AddForeignKey
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_claims" ADD CONSTRAINT "task_claims_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
