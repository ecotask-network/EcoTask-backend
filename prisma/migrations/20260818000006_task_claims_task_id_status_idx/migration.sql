-- getTaskClaims: WHERE task_id = ? AND status = 'active' AND expires_at > now()
CREATE INDEX CONCURRENTLY "task_claims_task_id_status_idx" ON "task_claims"("task_id", "status");
