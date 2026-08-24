export const TASK_EXPIRED_BEFORE_SUBMISSION_NOTE = 'task_expired_before_proof_submission';
export const TASK_UNAVAILABLE_FOR_APPROVAL_NOTE = 'task_unavailable_for_approval';

/**
 * A task deadline applies when the proof is submitted, not when an
 * asynchronous verifier happens to finalize it. The boundary is inclusive:
 * a proof created exactly at expiresAt is still eligible.
 */
export function getProofTaskApprovalBlockReason(
  proofCreatedAt: Date,
  task: { status: string; expiresAt: Date | null },
): string | null {
  if (
    (task.expiresAt !== null && proofCreatedAt.getTime() > task.expiresAt.getTime()) ||
    (task.status === 'EXPIRED' && task.expiresAt === null)
  ) {
    return TASK_EXPIRED_BEFORE_SUBMISSION_NOTE;
  }

  if (task.status !== 'ACTIVE' && task.status !== 'EXPIRED') {
    return TASK_UNAVAILABLE_FOR_APPROVAL_NOTE;
  }

  return null;
}
