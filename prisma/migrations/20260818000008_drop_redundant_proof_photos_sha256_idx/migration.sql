-- proof_photos.sha256 is UNIQUE (proof_photos_sha256_key), so the non-unique
-- proof_photos_sha256_idx created in 20260812000000 duplicates it: every
-- lookup on sha256 (duplicate-photo check) is already served by the unique
-- index. Dropping the duplicate cuts write amplification on photo inserts
-- with zero plan impact.
DROP INDEX CONCURRENTLY "proof_photos_sha256_idx";
