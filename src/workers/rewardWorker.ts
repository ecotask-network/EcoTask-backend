import { Worker, Queue } from 'bullmq';
import { submitReward } from '../services/stellarService';
import config from '../config/default';
import IORedis from 'ioredis';
import prisma from '../utils/prisma';
import logger from '../utils/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null }) as any;

export const rewardQueue = new Queue('reward-payout', { connection });

const worker = new Worker(
  'reward-payout',
  async (job) => {
    const { proofId } = job.data;
    logger.info('Processing reward payout', { proofId });

    const proof = await prisma.proof.findUnique({
      where: { id: proofId },
      include: { user: true, task: true },
    });
    if (!proof) throw new Error('Proof not found');

    const txHash = await submitReward({
      userWallet: proof.user.wallet,
      taskId: proof.taskId,
      amount: proof.task.rewardAmount,
      assetCode: proof.task.rewardToken || 'ECO',
    });

    logger.info('Reward paid successfully', { proofId, txHash });
  },
  { connection },
);

export default worker;
