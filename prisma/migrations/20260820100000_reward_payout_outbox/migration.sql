-- CreateEnum
CREATE TYPE "RewardPayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');

-- CreateTable
CREATE TABLE "reward_payouts" (
    "id" TEXT NOT NULL,
    "proof_id" TEXT NOT NULL,
    "request_id" TEXT,
    "status" "RewardPayoutStatus" NOT NULL DEFAULT 'PENDING',
    "tx_hash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reward_payouts_proof_id_key" ON "reward_payouts"("proof_id");

-- CreateIndex
CREATE INDEX "reward_payouts_status_next_attempt_at_idx" ON "reward_payouts"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "reward_payouts" ADD CONSTRAINT "reward_payouts_proof_id_fkey" FOREIGN KEY ("proof_id") REFERENCES "proofs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
