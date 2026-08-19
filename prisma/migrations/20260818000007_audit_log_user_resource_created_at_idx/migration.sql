-- getAuditLogs with both filters:
-- WHERE "userId" = ? AND resource = ? ORDER BY "createdAt" DESC LIMIT ? OFFSET ?
-- Equality on both filters, sort on createdAt → composite matches filter+sort.
CREATE INDEX CONCURRENTLY "AuditLog_userId_resource_createdAt_idx" ON "AuditLog"("userId", "resource", "createdAt" DESC);
