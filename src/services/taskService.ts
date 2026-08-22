import prisma from '../utils/prisma.js';
import logger from '../utils/logger.js';
import { finalizeProofStatus } from './proofFinalizationService.js';

export interface ExpirySweepResult {
  tasksExpired: number;
  claimsExpired: number;
}

export async function expireOverdueTasks(): Promise<ExpirySweepResult> {
  const now = new Date();

  const tasks = await prisma.task.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });

  const claims = await prisma.taskClaim.updateMany({
    where: { status: 'active', expiresAt: { lt: now } },
    data: { status: 'expired' },
  });

  if (tasks.count > 0 || claims.count > 0) {
    logger.info('Expiry sweep completed', {
      tasksExpired: tasks.count,
      claimsExpired: claims.count,
    });
  }

  return { tasksExpired: tasks.count, claimsExpired: claims.count };
}

export async function recoverOrphanedProofs(): Promise<number> {
  const maxAgeMs = parseInt(process.env.PROOF_ORPHAN_MAX_AGE_MS || String(30 * 60 * 1000), 10);
  const cutoff = new Date(Date.now() - maxAgeMs);

  const orphanedProofs = await prisma.proof.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: cutoff },
    },
    select: { id: true },
  });

  let recovered = 0;
  for (const proof of orphanedProofs) {
    try {
      await finalizeProofStatus({
        proofId: proof.id,
        verifierId: 'system-sweeper',
        verdict: 'rejected',
        notes: 'Proof orphaned due to system failure',
        requestId: `sweep-${Date.now()}`,
        expectedStatuses: ['PENDING'],
      });
      recovered++;
    } catch (err) {
      logger.error('Failed to recover orphaned proof', { proofId: proof.id, err });
    }
  }

  if (recovered > 0) {
    logger.info('Orphaned proofs recovered', { count: recovered });
  }

  return recovered;
}
