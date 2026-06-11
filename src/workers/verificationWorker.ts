import { Worker, Queue } from "bullmq";
import { autoVerify } from "../services/verificationService";
import config from "../config/default";
import IORedis from "ioredis";
import prisma from "../utils/prisma";

const connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null });

export const verificationQueue = new Queue("proof-verification", { connection: connection as any });

export async function enqueueVerification(proofId: string) {
  await verificationQueue.add("verify", { proofId }, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });
}

const worker = new Worker(
  "proof-verification",
  async (job) => {
    const { proofId } = job.data;
    console.log(`[VerificationWorker] Processing proof ${proofId}`);

    await prisma.proof.update({ where: { id: proofId }, data: { status: "VERIFYING" } });

    const result = await autoVerify(proofId);

    if (result.verdict === "approved") {
      await prisma.proof.update({ where: { id: proofId }, data: { status: "APPROVED" } });

      const { rewardQueue } = await import("./rewardWorker");
      await rewardQueue.add("payout", { proofId });
    } else if (result.verdict === "rejected") {
      await prisma.proof.update({ where: { id: proofId }, data: { status: "REJECTED" } });
    } else {
      console.log(`[VerificationWorker] Proof ${proofId} inconclusive — needs manual review`);
    }

    await prisma.verification.create({
      data: {
        proofId,
        verifierId: "auto-verifier",
        verdict: result.verdict,
        notes: result.notes || `confidence: ${result.confidence}`,
      },
    });
  },
  { connection: connection as any }
);

worker.on("completed", (job) => console.log(`[VerificationWorker] Job ${job.id} completed`));
worker.on("failed", (job, err) => console.error(`[VerificationWorker] Job ${job?.id} failed:`, err));

export default worker;
