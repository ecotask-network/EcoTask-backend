-- Prisma does not auto-index foreign keys. Proof details and the verification
-- worker load verifications via WHERE proof_id = ?.
CREATE INDEX CONCURRENTLY "verifications_proof_id_idx" ON "verifications"("proof_id");
