-- Capacity checks (submitProof, completeTaskIfFull):
-- WHERE task_id = ? AND status = 'APPROVED' (COUNT)
-- Created CONCURRENTLY to avoid blocking writes on the highest-write table.
CREATE INDEX CONCURRENTLY "proofs_task_id_status_idx" ON "proofs"("task_id", "status");
