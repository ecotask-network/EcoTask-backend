-- Community validator program with quorum voting
ALTER TABLE "users" ADD COLUMN "validator_reputation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "review_count" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "validator_votes" (
  "id" TEXT NOT NULL,
  "proof_id" TEXT NOT NULL,
  "validator_id" TEXT NOT NULL,
  "verdict" TEXT,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMP(3),
  CONSTRAINT "validator_votes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "validator_votes_proof_id_validator_id_key" ON "validator_votes"("proof_id", "validator_id");
CREATE INDEX "validator_votes_validator_id_decided_at_idx" ON "validator_votes"("validator_id", "decided_at");

ALTER TABLE "validator_votes" ADD CONSTRAINT "validator_votes_proof_id_fkey" FOREIGN KEY ("proof_id") REFERENCES "proofs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "validator_votes" ADD CONSTRAINT "validator_votes_validator_id_fkey" FOREIGN KEY ("validator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
