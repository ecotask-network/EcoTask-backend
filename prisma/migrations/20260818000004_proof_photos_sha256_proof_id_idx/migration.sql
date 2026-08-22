-- Duplicate-photo check (autoVerify): WHERE sha256 IN (...) AND proof_id != ?
-- Covering composite: equality on both columns, enables an index-only scan.
CREATE INDEX CONCURRENTLY "proof_photos_sha256_proof_id_idx" ON "proof_photos"("sha256", "proof_id");
