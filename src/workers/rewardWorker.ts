import { Worker, Queue } from "bullmq";
import { submitReward } from "../services/stellarService";
import config from "../config/default";
import IORedis from "ioredis";
import prisma from "../utils/prisma";

const connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null });

export const rewardQueue = new Queue("reward-payout", { connection: connection as any });

const worker = new Worker(
  "reward-payout",
  async (job) => {
    const { proofId } = job.data;
    console.log(`[RewardWorker] Processing payout for proof ${proofId}`);

    const proof = await prisma.proof.findUnique({
      where: { id: proofId },
      include: { user: true, task: true },
    });
    if (!proof) throw new Error("Proof not found");

    const txHash = await submitReward({
      userWallet: proof.user.wallet,
      taskId: proof.taskId,
      amount: proof.task.rewardAmount,
      assetCode: proof.task.rewardToken || "ECO",
    });

    console.log(`[RewardWorker] Reward paid, tx: ${txHash}`);
  },
  { connection: connection as any }
);

export default worker;
