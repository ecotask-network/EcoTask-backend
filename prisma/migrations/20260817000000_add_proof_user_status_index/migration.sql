-- Add index on (user_id, status) for optimized getUserImpact queries
CREATE INDEX "proofs_user_id_status_idx" ON "proofs"("user_id", "status");
