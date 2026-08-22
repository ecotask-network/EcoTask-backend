-- Prisma does not auto-index foreign keys. Every proof detail/verification
-- flow loads photos via WHERE proof_id = ?.
CREATE INDEX CONCURRENTLY "proof_photos_proof_id_idx" ON "proof_photos"("proof_id");
