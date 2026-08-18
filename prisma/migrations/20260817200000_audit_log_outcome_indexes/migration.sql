-- Add outcome, statusCode, and durationMs columns to AuditLog
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "outcome"     TEXT;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "statusCode"  INTEGER;
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "durationMs"  INTEGER;

-- Indexes to keep GET /api/audit sub-100 ms at 100k rows
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx"
    ON "AuditLog" ("createdAt" DESC);

CREATE INDEX IF NOT EXISTS "AuditLog_userId_createdAt_idx"
    ON "AuditLog" ("userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "AuditLog_resource_createdAt_idx"
    ON "AuditLog" ("resource", "createdAt" DESC);
