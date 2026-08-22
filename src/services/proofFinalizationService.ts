import prisma from '../utils/prisma.js';
import { claimCompletionSlot } from '../models/task.js';
import { notifyProofStatus } from './notificationService.js';
import logger from '../utils/logger.js';
import { Prisma } from '@prisma/client';

export interface FinalizeProofOptions {
  proofId: string;
  verifierId: string;
  verdict: 'approved' | 'rejected';
  notes?: string;
  requestId?: string;
  expectedStatuses: ('PENDING' | 'VERIFYING')[];
}

export interface FinalizeProofResult {
  finalStatus: 'APPROVED' | 'REJECTED';
  taskCompleted: boolean;
  proofRecord: { userId: string; taskId: string };
}

export class ProofFinalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProofFinalizationError';
  }
}

/**
 * Shared logic to finalize a proof atomically.
 * Uses a row lock (FOR UPDATE) to prevent concurrent finalizations.
 */
export async function finalizeProofStatus({
  proofId,
  verifierId,
  verdict,
  notes,
  requestId,
  expectedStatuses,
}: FinalizeProofOptions): Promise<FinalizeProofResult> {
  const requestedStatus = verdict === 'approved' ? 'APPROVED' : 'REJECTED';

  return await prisma.$transaction(async (tx) => {
    // 1. Acquire row lock
    const proofs = await tx.$queryRaw<{ status: string; task_id: string; user_id: string }[]>`
      SELECT status, task_id, user_id
      FROM proofs
      WHERE id = ${proofId}
      FOR UPDATE
    `;

    if (proofs.length === 0) {
      throw new ProofFinalizationError('Proof not found');
    }

    const proofRow = proofs[0];

    // 2. Check state machine
    if (proofRow.status === 'APPROVED' || proofRow.status === 'REJECTED') {
      throw new ProofFinalizationError('Proof already has a final verdict');
    }

    if (!expectedStatuses.includes(proofRow.status as any)) {
      throw new ProofFinalizationError(`Proof is currently ${proofRow.status}, cannot be finalized by this actor`);
    }

    let finalStatus: 'APPROVED' | 'REJECTED' = requestedStatus;
    let taskCompleted = false;
    let finalNotes = notes || '';

    // 3. Claim task slot if approved
    if (requestedStatus === 'APPROVED') {
      const slot = await claimCompletionSlot(tx, proofRow.task_id);
      if (!slot.claimed) {
        finalStatus = 'REJECTED';
        finalNotes = `${finalNotes} [auto-rejected: task reached max completions]`.trim();
      } else {
        taskCompleted = slot.taskCompleted;
      }
    }

    // 4. Update proof status
    await tx.proof.update({
      where: { id: proofId },
      data: { status: finalStatus },
    });

    // 5. Create verification record
    await tx.verification.create({
      data: {
        proofId,
        verifierId,
        verdict: verdict,
        notes: finalNotes,
      },
    });

    // 6. Enqueue notifications
    if (requestId) {
      await notifyProofStatus(proofRow.user_id, proofId, finalStatus, tx, requestId);
    } else {
      await notifyProofStatus(proofRow.user_id, proofId, finalStatus, tx);
    }

    // 7. Enqueue reward payout if approved
    if (finalStatus === 'APPROVED') {
      await tx.rewardPayout.create({
        data: {
          proofId,
          ...(requestId ? { requestId } : {}),
        },
      });
    }

    return { 
      finalStatus, 
      taskCompleted, 
      proofRecord: { userId: proofRow.user_id, taskId: proofRow.task_id } 
    };
  });
}
