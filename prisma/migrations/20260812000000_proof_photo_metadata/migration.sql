-- Add photo metadata and content hash for proof verification
ALTER TABLE "proof_photos" ADD COLUMN "sha256" TEXT;
ALTER TABLE "proof_photos" ADD COLUMN "width" INTEGER;
ALTER TABLE "proof_photos" ADD COLUMN "height" INTEGER;
ALTER TABLE "proof_photos" ADD COLUMN "captured_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "proof_photos_sha256_key" ON "proof_photos"("sha256");
CREATE INDEX "proof_photos_sha256_idx" ON "proof_photos"("sha256");
