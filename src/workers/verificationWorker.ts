import { Worker, Queue } from 'bullmq';
import { autoVerify } from '../services/verificationService';
import { notifyProofStatus } from '../services/notificationService';
import { assignValidators } from '../services/validatorService';
import { completeTaskIfFull } from '../models/task';
import { enqueueRewardPayout } from './rewardWorker';
import config from '../config/default';
import IORedis from 'ioredis';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { getRequestId, runWithRequestContext } from '../utils/requestContext.js';
import { getQueueRetentionOptions, QUEUE_NAMES } from './queueRetention.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null }) as any;

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

      const proof = await prisma.proof.findUnique({
        where: { id: proofId },
        select: { userId: true, taskId: true, status: true },
      });
      if (!proof) throw new Error('Proof not found');

      if (proof.status !== 'PENDING') {
        logger.info('Skipping proof already processed', {
          proofId,
          status: proof.status,
          ...requestMeta,
        });
        return;
      }

      await prisma.proof.update({
        where: { id: proofId },
        data: { status: 'VERIFYING' },
      });

      const result = await autoVerify(proofId);

      if (result.verdict === 'approved') {
        await prisma.$transaction(async (tx) => {
          await tx.proof.update({
            where: { id: proofId },
            data: { status: 'APPROVED' },
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
            await notifyProofStatus(proof.userId, proofId, 'APPROVED', tx, requestId);
          } else {
            await notifyProofStatus(proof.userId, proofId, 'APPROVED', tx);
          }
        });

        const completed = await completeTaskIfFull(proof.taskId);
        if (completed) {
          logger.info('Task reached capacity and was completed', {
            taskId: proof.taskId,
            ...requestMeta,
          });
        }

        await enqueueRewardPayout(proofId, requestId);
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
  await connection.quit();
  logger.info('Verification worker shut down');
}

export default worker;
