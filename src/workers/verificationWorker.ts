import { Worker, Queue } from 'bullmq';
import { autoVerify } from '../services/verificationService';
import config from '../config/default';
import IORedis, { Redis } from 'ioredis';
import prisma from '../utils/prisma';
import logger from '../utils/logger';

const connection: Redis = new IORedis(config.redis.url, { maxRetriesPerRequest: null });

export const verificationQueue = new Queue('proof-verification', { connection });

export async function enqueueVerification(proofId: string) {
  await verificationQueue.add(
    'verify',
    { proofId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    },
  );
}

const worker = new Worker(
  'proof-verification',
  async (job) => {
    const { proofId } = job.data;
    logger.info({ proofId, message: 'Processing proof verification' });

    await prisma.proof.update({ where: { id: proofId }, data: { status: 'VERIFYING' } });

    const result = await autoVerify(proofId);

    if (result.verdict === 'approved') {
      await prisma.proof.update({ where: { id: proofId }, data: { status: 'APPROVED' } });

      const { rewardQueue } = await import('./rewardWorker.js');
      await rewardQueue.add('payout', { proofId });
    } else if (result.verdict === 'rejected') {
      await prisma.proof.update({ where: { id: proofId }, data: { status: 'REJECTED' } });
    } else {
      logger.info({ proofId, message: 'Proof inconclusive — needs manual review' });
    }

    await prisma.verification.create({
      data: {
        proofId,
        verifierId: 'auto-verifier',
        verdict: result.verdict,
        notes: result.notes || `confidence: ${result.confidence}`,
      },
    });
  },
  { connection },
);

worker.on('completed', (job) =>
  logger.info({ jobId: job.id, message: 'Verification job completed' }),
);
worker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, err, message: 'Verification job failed' }),
);

export default worker;
