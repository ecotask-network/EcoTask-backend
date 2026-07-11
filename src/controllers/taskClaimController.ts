import { Request, Response } from "express";
import prisma from "../utils/prisma.js";

const CLAIM_DURATION_MS = 24 * 60 * 60 * 1000;

export async function claimTask(req: Request, res: Response) {
  const { id: taskId } = req.params;
  const userId = req.user!.userId;

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) {
    return res.status(404).json({ error: "task not found" });
  }
  if (task.status !== "ACTIVE") {
    return res.status(400).json({ error: "task is not active" });
  }

  const existingClaim = await prisma.taskClaim.findUnique({
    where: { taskId_userId: { taskId, userId } },
  });

  if (existingClaim && existingClaim.status === "active" && existingClaim.expiresAt > new Date()) {
    return res.status(409).json({ error: "task already claimed by you" });
  }

  if (existingClaim) {
    const updated = await prisma.taskClaim.update({
      where: { id: existingClaim.id },
      data: {
        status: "active",
        claimedAt: new Date(),
        expiresAt: new Date(Date.now() + CLAIM_DURATION_MS),
      },
    });
    return res.json({ claim: updated });
  }

  const claim = await prisma.taskClaim.create({
    data: {
      userId,
      taskId,
      status: "active",
      expiresAt: new Date(Date.now() + CLAIM_DURATION_MS),
    },
  });

  return res.status(201).json({ claim });
}

export async function releaseClaim(req: Request, res: Response) {
  const { id: taskId } = req.params;
  const userId = req.user!.userId;

  const claim = await prisma.taskClaim.findUnique({
    where: { taskId_userId: { taskId, userId } },
  });

  if (!claim || claim.status !== "active") {
    return res.status(404).json({ error: "no active claim found" });
  }

  await prisma.taskClaim.update({
    where: { id: claim.id },
    data: { status: "released" },
  });

  return res.status(204).send();
}

export async function getTaskClaims(req: Request, res: Response) {
  const { id: taskId } = req.params;

  const claims = await prisma.taskClaim.findMany({
    where: {
      taskId,
      status: "active",
      expiresAt: { gt: new Date() },
    },
    include: { user: { select: { id: true, wallet: true, name: true } } },
  });

  return res.json({ claims });
}
