import { Worker, Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { autoVerify } from '../services/verificationService';
import { notifyProofStatus } from '../services/notificationService';
import { assignValidators } from '../services/validatorService';
import { claimCompletionSlot } from '../models/task';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { redisConnectionManager } from '../utils/redisConnectionManager.js';
import { getRequestId, runWithRequestContext } from '../utils/requestContext.js';
import { getQueueRetentionOptions, QUEUE_NAMES } from './queueRetention.js';

// BullMQ bundles its own ioredis, so its `ConnectionOptions` is a structurally
// distinct type from our top-level ioredis `Redis`. The cast is purely
// type-level: both are the same ioredis client at runtime.
const connection = redisConnectionManager.getClient() as ConnectionOptions;

const queueName = QUEUE_NAMES.proofVerification;
const retentionOptions = getQueueRetentionOptions(queueName);

interface VerificationJobData {
  proofId: string;
  requestId?: string;
}

export const verificationQueue = new Queue<VerificationJobData>(queueName, {
  connection,
  defaultJobOptions: retentionOptions,
});

export async function enqueueVerification(proofId: string, requestId?: string) {
  const resolvedRequestId = requestId ?? getRequestId();
  await verificationQueue.add(
    'verify',
    { proofId, ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}) },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      ...retentionOptions,
    },
  );
}

const worker = new Worker<VerificationJobData>(
  queueName,
  async (job) => {
    const { proofId, requestId } = job.data;
    const requestMeta = requestId ? { requestId } : {};

    return runWithRequestContext(requestId, async () => {
      logger.info('Processing proof verification', { proofId, ...requestMeta });

      const { count: claimed } = await prisma.proof.updateMany({
        where: { id: proofId, status: 'PENDING' },
        data: { status: 'VERIFYING' },
      });
      if (claimed === 0) {
        const existing = await prisma.proof.findUnique({
          where: { id: proofId },
          select: { status: true },
        });
        logger.info('Skipping proof already processed', {
          proofId,
          status: existing?.status ?? 'UNKNOWN',
          ...requestMeta,
        });
        return;
      }

      const proof = await prisma.proof.findUnique({
        where: { id: proofId },
        select: { userId: true, taskId: true },
      });
      if (!proof) throw new Error('Proof not found');

      const result = await autoVerify(proofId);

      if (result.verdict === 'approved') {
        const { finalStatus, taskCompleted } = await prisma.$transaction(async (tx) => {
          let finalStatus: 'APPROVED' | 'REJECTED' = 'APPROVED';
          let taskCompleted = false;
          let notes = result.notes || `confidence: ${result.confidence}`;

          const slot = await claimCompletionSlot(tx, proof.taskId);
          if (!slot.claimed) {
            finalStatus = 'REJECTED';
            notes += ' [auto-rejected: task reached max completions]';
          } else {
            taskCompleted = slot.taskCompleted;
          }

          await tx.proof.update({
            where: { id: proofId },
            data: { status: finalStatus },
          });
          await tx.verification.create({
            data: {
              proofId,
              verifierId: 'auto-verifier',
              verdict: result.verdict,
              notes,
            },
          });
          if (requestId) {
            await notifyProofStatus(proof.userId, proofId, finalStatus, tx, requestId);
          } else {
            await notifyProofStatus(proof.userId, proofId, finalStatus, tx);
          }

          if (finalStatus === 'APPROVED') {
            await tx.rewardPayout.create({
              data: {
                proofId,
                ...(requestId ? { requestId } : {}),
              },
            });
          }

          return { finalStatus, taskCompleted };
        });

        if (finalStatus === 'APPROVED') {
          if (taskCompleted) {
            logger.info('Task reached capacity and was completed', {
              taskId: proof.taskId,
              ...requestMeta,
            });
          }
        } else {
          logger.info('Auto-approved proof rejected: task at capacity', {
            proofId,
            taskId: proof.taskId,
            ...requestMeta,
          });
        }
      } else if (result.verdict === 'rejected') {
        await prisma.$transaction(async (tx) => {
          await tx.proof.update({
            where: { id: proofId },
            data: { status: 'REJECTED' },
          });
          await tx.verification.create({
            data: {
              proofId,
              verifierId: 'auto-verifier',
              verdict: result.verdict,
              notes: result.notes || `confidence: ${result.confidence}`,
            },
          });
          if (requestId) {
            await notifyProofStatus(proof.userId, proofId, 'REJECTED', tx, requestId);
          } else {
            await notifyProofStatus(proof.userId, proofId, 'REJECTED', tx);
          }
        });
      } else {
        const assigned = await assignValidators(proofId);
        if (assigned > 0) {
          logger.info('Proof assigned to community validators', {
            proofId,
            assigned,
            ...requestMeta,
          });
        } else {
          logger.info(
            'Proof inconclusive — no validators available, needs manual review',
            {
              proofId,
              ...requestMeta,
            },
          );
        }

        await prisma.verification.create({
          data: {
            proofId,
            verifierId: 'auto-verifier',
            verdict: result.verdict,
            notes: result.notes || `confidence: ${result.confidence}`,
          },
        });
      }
    });
  },
  { connection },
);

worker.on('completed', (job) =>
  logger.info('Verification job completed', {
    jobId: job.id,
    ...(job.data.requestId ? { requestId: job.data.requestId } : {}),
  }),
);
worker.on('failed', (job, err) =>
  logger.error('Verification job failed', {
    jobId: job?.id,
    ...(job?.data?.requestId ? { requestId: job.data.requestId } : {}),
    err,
  }),
);

export async function shutdownVerificationWorker(): Promise<void> {
  await worker.close();
  await verificationQueue.close();
  logger.info('Verification worker shut down');
}

export default worker;
