import { Worker, Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { submitReward } from '../services/stellarService';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { redisConnectionManager } from '../utils/redisConnectionManager.js';
import { getRequestId, runWithRequestContext } from '../utils/requestContext.js';
import { getQueueRetentionOptions, QUEUE_NAMES } from './queueRetention.js';

let queue: Queue<RewardJobData> | null = null;
let worker: Worker<RewardJobData> | null = null;
const queueName = QUEUE_NAMES.rewardPayout;
const retentionOptions = getQueueRetentionOptions(queueName);

export interface RewardJobData {
  payoutId: string;
  proofId: string;
  requestId?: string;
}

// BullMQ bundles its own ioredis; the cast is purely type-level — it is the
// same shared ioredis client at runtime.
function getConnection(): ConnectionOptions {
  return redisConnectionManager.getClient() as ConnectionOptions;
}

function getQueue(): Queue<RewardJobData> {
  if (!queue) {
    queue = new Queue<RewardJobData>(queueName, {
      connection: getConnection(),
      defaultJobOptions: retentionOptions,
    });
  }
  return queue;
}

/**
 * Enqueues a reward-payout job for the given RewardPayout outbox row.
 * Uses the payoutId as the BullMQ jobId so duplicate enqueues are no-ops.
 * This function is called by the reward-payout sweeper, not directly by
 * the approval paths.
 */
export async function enqueueRewardPayout(
  payoutId: string,
  proofId: string,
  requestId?: string,
): Promise<void> {
  const resolvedRequestId = requestId ?? getRequestId();
  await getQueue().add(
    'payout',
    { payoutId, proofId, ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}) },
    {
      jobId: payoutId,
      ...retentionOptions,
    },
  );
}

export function startRewardWorker(): void {
  if (worker) return;
  worker = new Worker<RewardJobData>(
    queueName,
    async (job) => {
      const { payoutId, proofId, requestId } = job.data;
      const requestMeta = requestId ? { requestId } : {};

      return runWithRequestContext(requestId, async () => {
        logger.info('Processing reward payout', { proofId, payoutId, ...requestMeta });

        const claim = await prisma.rewardPayout.updateMany({
          where: { id: payoutId, status: 'PENDING' },
          data: { status: 'PROCESSING' },
        });
        if (claim.count === 0) {
          logger.info('Skipping payout already claimed or completed', {
            proofId,
            payoutId,
            ...requestMeta,
          });
          return;
        }

        const proof = await prisma.proof.findUnique({
          where: { id: proofId },
          include: { user: true, task: true },
        });
        if (!proof) {
          throw new Error('Proof not found');
        }

        if (proof.status !== 'APPROVED') {
          await prisma.rewardPayout.update({
            where: { id: payoutId },
            data: { status: 'FAILED', lastError: `Proof in state '${proof.status}'` },
          });
          throw new Error(`Cannot pay reward for proof in state '${proof.status}'`);
        }

        let txHash: string;
        try {
          txHash = await submitReward({
            userWallet: proof.user.wallet,
            taskId: proof.taskId,
            amount: proof.task.rewardAmountMicros.toString(),
            assetCode: proof.task.rewardToken || 'ECO',
            payoutId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await prisma.rewardPayout.update({
            where: { id: payoutId },
            data: {
              status: 'FAILED',
              lastError: message,
              attempts: { increment: 1 },
            },
          });
          throw err;
        }

        await prisma.$transaction(async (tx) => {
          await tx.rewardPayout.update({
            where: { id: payoutId },
            data: { status: 'PAID', txHash },
          });
          await tx.proof.update({
            where: { id: proofId },
            data: { rewardedAt: new Date() },
          });
        });

        logger.info('Reward paid successfully', {
          proofId,
          payoutId,
          txHash,
          ...requestMeta,
        });
      });
    },
    { connection: getConnection() },
  );

  worker.on('completed', (job) =>
    logger.info('Reward job completed', {
      jobId: job.id,
      ...(job.data.requestId ? { requestId: job.data.requestId } : {}),
    }),
  );
  worker.on('failed', (job, err) =>
    logger.error('Reward job failed', {
      jobId: job?.id,
      ...(job?.data?.requestId ? { requestId: job.data.requestId } : {}),
      err,
    }),
  );
}

export async function shutdownRewardWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info('Reward worker shut down');
}

export default startRewardWorker;
