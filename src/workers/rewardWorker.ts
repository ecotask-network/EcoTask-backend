import { Worker, Queue } from 'bullmq';
import { submitReward } from '../services/stellarService';
import config from '../config/default';
import IORedis, { Redis } from 'ioredis';
import prisma from '../utils/prisma';
import logger from '../utils/logger';

const connection: Redis = new IORedis(config.redis.url, { maxRetriesPerRequest: null });

export const rewardQueue = new Queue('reward-payout', { connection });

const worker = new Worker(
  'reward-payout',
  async (job) => {
    const { proofId } = job.data;
    logger.info({ proofId, message: 'Processing reward payout' });

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

    logger.info({ proofId, txHash, message: 'Reward paid successfully' });
  },
  { connection },
);

export default worker;
