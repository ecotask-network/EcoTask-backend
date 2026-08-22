import prisma from '../utils/prisma.js';
import config from '../config/default.js';
import logger from '../utils/logger.js';
import { notifyProofStatus } from './notificationService.js';
import { claimCompletionSlot } from '../models/task.js';

const AUTO_VERIFIER_ID = 'quorum';

export interface QuorumOutcome {
  finalized: boolean;
  status?: 'APPROVED' | 'REJECTED';
  escalated?: boolean;
}

/**
 * Assigns up to `count` active community validators to an inconclusive proof.
 * Picks the least-loaded validators (lowest reviewCount) for fair work
 * distribution and never assigns the proof's own submitter.
 */
export async function assignValidators(
  proofId: string,
  count: number = config.validator.assignmentCount,
): Promise<number> {
  const proof = await prisma.proof.findUnique({
    where: { id: proofId },
    select: { userId: true, status: true },
  });
  if (!proof) throw new Error('Proof not found');
  if (proof.status !== 'VERIFYING' && proof.status !== 'PENDING') return 0;

  const existing = await prisma.validatorVote.count({ where: { proofId } });
  if (existing > 0) return 0;

  const validators = await prisma.user.findMany({
    where: { role: 'validator', id: { not: proof.userId } },
    orderBy: { reviewCount: 'asc' },
    take: count,
    select: { id: true },
  });

  if (validators.length === 0) return 0;

  await prisma.validatorVote.createMany({
    data: validators.map((v) => ({ proofId, validatorId: v.id })),
  });

  logger.info('Proof assigned to community validators', {
    proofId,
    assigned: validators.length,
  });
  return validators.length;
}

export async function listPendingReviews(validatorId: string) {
  return prisma.validatorVote.findMany({
    where: { validatorId, verdict: null },
    include: {
      proof: {
        include: {
          photos: true,
          task: {
            select: {
              id: true,
              title: true,
              type: true,
              lat: true,
              lng: true,
              radiusMeters: true,
            },
          },
          user: { select: { id: true, wallet: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function castVote(
  proofId: string,
  validatorId: string,
  verdict: 'approved' | 'rejected',
  notes?: string,
  requestId?: string,
): Promise<QuorumOutcome> {
  const vote = await prisma.validatorVote.findUnique({
    where: { proofId_validatorId: { proofId, validatorId } },
    include: { proof: { select: { status: true } } },
  });
  if (!vote) throw new Error('Vote not found for this validator');
  if (vote.verdict) throw new Error('Vote already cast');
  if (vote.proof.status !== 'VERIFYING' && vote.proof.status !== 'PENDING') {
    throw new Error('Proof is not awaiting validator review');
  }

  await prisma.validatorVote.update({
    where: { id: vote.id },
    data: { verdict, notes, decidedAt: new Date() },
  });

  await prisma.user.update({
    where: { id: validatorId },
    data: { reviewCount: { increment: 1 } },
  });

  return resolveQuorum(proofId, requestId);
}

/**
 * Resolves a proof once enough validators have agreed on a verdict. Returns
 * when a quorum is reached (finalizing the proof, notifying the user and
 * triggering the reward), or escalates to manual review when all assigned
 * validators have voted without reaching agreement.
 */
export async function resolveQuorum(
  proofId: string,
  requestId?: string,
): Promise<QuorumOutcome> {
  const proof = await prisma.proof.findUnique({
    where: { id: proofId },
    include: { validatorVotes: true },
  });
  if (!proof) throw new Error('Proof not found');
  if (proof.status === 'APPROVED' || proof.status === 'REJECTED') {
    return { finalized: false, status: proof.status };
  }

  const submitted = proof.validatorVotes.filter((v) => v.verdict);
  if (submitted.length === 0) return { finalized: false };

  const tallies: Record<string, number> = {};
  for (const vote of submitted) {
    tallies[vote.verdict!] = (tallies[vote.verdict!] || 0) + 1;
  }

  const winner = Object.entries(tallies).find(
    ([, count]) => count >= config.validator.quorumRequired,
  )?.[0] as 'approved' | 'rejected' | undefined;

  if (winner) {
    return finalizeProof(proofId, winner, submitted, requestId);
  }

  const allVoted = submitted.length >= proof.validatorVotes.length;
  if (allVoted) {
    await prisma.verification.create({
      data: {
        proofId,
        verifierId: AUTO_VERIFIER_ID,
        verdict: 'inconclusive',
        // No Proof.status change occurs on escalation; effectiveVerdict
        // mirrors the intent.
        effectiveVerdict: 'inconclusive',
        notes: 'no quorum reached; escalated to admin review',
      },
    });
    logger.info('Validator review escalated to admin (no quorum)', { proofId });
    return { finalized: false, escalated: true };
  }

  return { finalized: false };
}

async function finalizeProof(
  proofId: string,
  verdict: 'approved' | 'rejected',
  submitted: { validatorId: string; verdict: string | null }[],
  requestId?: string,
): Promise<QuorumOutcome> {
  const requestedStatus = verdict === 'approved' ? 'APPROVED' : 'REJECTED';
  const agreement = submitted.filter((v) => v.verdict === verdict);
  const disagreement = submitted.filter((v) => v.verdict !== verdict);

  const result = await prisma.$transaction(async (tx) => {
    const proofRow = await tx.proof.findUnique({
      where: { id: proofId },
      select: { taskId: true, status: true },
    });
    if (!proofRow) return null;
    if (proofRow.status === 'APPROVED' || proofRow.status === 'REJECTED') {
      return null;
    }

    let finalStatus: 'APPROVED' | 'REJECTED' = requestedStatus;
    let taskCompleted = false;
    let notes = `quorum of ${agreement.length} validators`;

    if (requestedStatus === 'APPROVED') {
      const slot = await claimCompletionSlot(tx, proofRow.taskId);
      if (!slot.claimed) {
        finalStatus = 'REJECTED';
        notes += ' [auto-rejected: task reached max completions]';
      } else {
        taskCompleted = slot.taskCompleted;
      }
    }

    const { count } = await tx.proof.updateMany({
      where: { id: proofId, status: { in: ['PENDING', 'VERIFYING'] } },
      data: { status: finalStatus },
    });
    if (count === 0) return null;

    await tx.verification.create({
      data: {
        proofId,
        verifierId: AUTO_VERIFIER_ID,
        verdict,
        // effectiveVerdict always matches the resulting Proof.status
        // (lower-case). When a capacity check overrides an 'approved'
        // quorum verdict the two fields intentionally differ.
        effectiveVerdict: finalStatus.toLowerCase(),
        notes,
      },
    });

    for (const v of agreement) {
      await tx.user.update({
        where: { id: v.validatorId },
        data: { validatorReputation: { increment: 1 } },
      });
    }
    for (const v of disagreement) {
      await tx.user.update({
        where: { id: v.validatorId },
        data: { validatorReputation: { decrement: 1 } },
      });
    }

    const proofRecord = await tx.proof.findUnique({
      where: { id: proofId },
      select: { userId: true, taskId: true },
    });
    if (proofRecord) {
      if (requestId) {
        await notifyProofStatus(proofRecord.userId, proofId, finalStatus, tx, requestId);
      } else {
        await notifyProofStatus(proofRecord.userId, proofId, finalStatus, tx);
      }
    }

    if (finalStatus === 'APPROVED') {
      await tx.rewardPayout.create({
        data: {
          proofId,
          ...(requestId ? { requestId } : {}),
        },
      });
    }

    return { proofRecord, finalStatus, taskCompleted };
  });

  if (result?.proofRecord && result.finalStatus === 'APPROVED') {
    if (result.taskCompleted) {
      logger.info('Task reached capacity and was completed', {
        taskId: result.proofRecord.taskId,
      });
    }
  }

  logger.info('Quorum reached, proof finalized', {
    proofId,
    status: result?.finalStatus ?? requestedStatus,
  });
  return { finalized: true, status: result?.finalStatus ?? requestedStatus };
}
