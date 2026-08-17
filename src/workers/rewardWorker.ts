import { Worker, Queue } from 'bullmq';
import { submitReward } from '../services/stellarService';
import config from '../config/default';
import IORedis from 'ioredis';
import prisma from '../utils/prisma';
import logger from '../utils/logger';
import { getQueueRetentionOptions, QUEUE_NAMES } from './queueRetention.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connection: any = null;
let queue: Queue | null = null;
let worker: Worker | null = null;
const queueName = QUEUE_NAMES.rewardPayout;
const retentionOptions = getQueueRetentionOptions(queueName);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getConnection(): any {
  if (!connection) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null }) as any;
  }
  return connection;
}

function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(queueName, {
      connection: getConnection(),
      defaultJobOptions: retentionOptions,
    });
  }
  return queue;
}

export async function enqueueRewardPayout(proofId: string): Promise<void> {
  await getQueue().add('payout', { proofId }, retentionOptions);
}

export function startRewardWorker(): void {
  if (worker) return;
  worker = new Worker(
    queueName,
    async (job) => {
      const { proofId } = job.data;
      logger.info('Processing reward payout', { proofId });

      const proof = await prisma.proof.findUnique({
        where: { id: proofId },
        include: { user: true, task: true },
      });
      if (!proof) throw new Error('Proof not found');

      if (proof.status !== 'APPROVED') {
        throw new Error(`Cannot pay reward for proof in state '${proof.status}'`);
      }
      if (proof.rewardedAt) {
        logger.info('Skipping payout already processed', {
          proofId,
          rewardedAt: proof.rewardedAt,
        });
        return;
      }

      const txHash = await submitReward({
        userWallet: proof.user.wallet,
        taskId: proof.taskId,
        amount: proof.task.rewardAmount,
        assetCode: proof.task.rewardToken || 'ECO',
      });

      await prisma.proof.update({
        where: { id: proofId },
        data: { rewardedAt: new Date() },
      });

      logger.info('Reward paid successfully', { proofId, txHash });
    },
    { connection: getConnection() },
  );

  worker.on('completed', (job) => logger.info('Reward job completed', { jobId: job.id }));
  worker.on('failed', (job, err) =>
    logger.error('Reward job failed', { jobId: job?.id, err }),
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
  if (connection) {
    await connection.quit();
    connection = null;
  }
  logger.info('Reward worker shut down');
}

export default startRewardWorker;
