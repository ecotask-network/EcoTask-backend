import { Worker, Queue } from 'bullmq';
import { autoVerify } from '../services/verificationService';
import config from '../config/default';
import IORedis from 'ioredis';
import prisma from '../utils/prisma';
import logger from '../utils/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null }) as any;

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
    logger.info('Processing proof verification', { proofId });

    await prisma.proof.update({ where: { id: proofId }, data: { status: 'VERIFYING' } });

    const result = await autoVerify(proofId);

    if (result.verdict === 'approved') {
      await prisma.proof.update({ where: { id: proofId }, data: { status: 'APPROVED' } });

      const { rewardQueue } = await import('./rewardWorker.js');
      await rewardQueue.add('payout', { proofId });
    } else if (result.verdict === 'rejected') {
      await prisma.proof.update({ where: { id: proofId }, data: { status: 'REJECTED' } });
    } else {
      logger.info('Proof inconclusive — needs manual review', { proofId });
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
  logger.info('Verification job completed', { jobId: job.id }),
);
worker.on('failed', (job, err) =>
  logger.error('Verification job failed', { jobId: job?.id, err }),
);

export default worker;
