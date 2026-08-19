import { Request, Response } from 'express';
import fs from 'fs';
import prisma from '../utils/prisma.js';
import {
  submitProofSchema,
  listProofsQuerySchema,
  listPendingProofsQuerySchema,
  reviewProofSchema,
  MAX_PAGINATION_LIMIT,
} from '../utils/validation.js';
import { uploadToIPFS } from '../services/ipfsService.js';
import { isWithinZone } from '../services/geoService.js';
import { hashFile, extractPhotoMetadata } from '../services/photoService.js';
import { notifyProofStatus } from '../services/notificationService.js';
import { enqueueVerification } from '../workers/verificationWorker.js';
import { enqueueRewardPayout } from '../workers/rewardWorker.js';
import { completeTaskIfFull } from '../models/task.js';
import logger from '../utils/logger.js';

export async function submitProof(req: Request, res: Response) {
  const parsed = submitProofSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid request body', details: parsed.error.flatten() });
  }

  const { taskId, lat: bodyLat, lng: bodyLng, notes } = parsed.data;
  const userId = req.user!.userId;

  type EligibilityResult =
    | { status: 404 | 400 | 403 | 409; error: string }
    | {
        status: 200;
        task: { lat: number; lng: number; radiusMeters: number };
      };

  // Reject invalid submissions before doing expensive photo work. Eligibility
  // is checked again in the write transaction below so capacity and claim
  // validity cannot race with proof creation.
  const eligibility: EligibilityResult = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) {
      return { status: 404 as const, error: 'task not found' };
    }
    if (task.status !== 'ACTIVE') {
      return { status: 400 as const, error: 'task is not active' };
    }

    const claim = await tx.taskClaim.findFirst({
      where: {
        taskId,
        userId,
        status: 'active',
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!claim) {
      return {
        status: 403 as const,
        error: 'active claim required to submit proof for this task',
      };
    }

    if (task.maxCompletions != null) {
      const completed = await tx.proof.count({
        where: { taskId, status: 'APPROVED' },
      });
      if (completed >= task.maxCompletions) {
        return { status: 409 as const, error: 'task has reached maximum completions' };
      }
    }

    return { status: 200 as const, task };
  });

  if (eligibility.status !== 200) {
    return res.status(eligibility.status).json({ error: eligibility.error });
  }

  let gpsFromPhoto: { lat: number; lng: number } | null = null;
  const preparedPhotos: Array<{
    cid: string;
    filename: string;
    sha256: string;
    width: number | null;
    height: number | null;
    capturedAt: Date | null;
  }> = [];

  const files = req.files as Express.Multer.File[] | undefined;
  if (files && files.length > 0) {
    const fileResults = await Promise.allSettled(
      files.map(async (file) => {
        try {
          const [sha256, metadata] = await Promise.all([
            hashFile(file.path),
            extractPhotoMetadata(file.path),
          ]);
          const cid = await uploadToIPFS(file.path, file.filename);

          return {
            photo: {
              cid,
              filename: file.originalname,
              sha256,
              width: metadata.width,
              height: metadata.height,
              capturedAt: metadata.capturedAt,
            },
            metadata,
          };
        } finally {
          try {
            await fs.promises.unlink(file.path);
          } catch (err) {
            logger.warn('Failed to clean up uploaded file', { err, path: file.path });
          }
        }
      }),
    );

    const failedFile = fileResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failedFile) {
      logger.error('Failed to process proof photos', {
        err: failedFile.reason,
        requestId: req.requestId,
        taskId,
        userId,
      });
      return res.status(500).json({ error: 'failed to process proof photos' });
    }

    for (const result of fileResults) {
      if (result.status !== 'fulfilled') continue;
      preparedPhotos.push(result.value.photo);
      const { metadata } = result.value;
      if (metadata.gpsLat != null && metadata.gpsLng != null) {
        gpsFromPhoto ??= { lat: metadata.gpsLat, lng: metadata.gpsLng };
      }
    }
  }

  // ── GPS cross-check ─────────────────────────────────────────────────────────
  // When the client supplies body coordinates AND the photo carries its own EXIF
  // GPS, we verify they agree to within the task radius.  A mismatch means the
  // submitted body coordinates may be spoofed: we store a flag and route the
  // proof to manual validator review rather than trusting auto-verification.
  let gpsMismatch = false;
  if (bodyLat != null && bodyLng != null && gpsFromPhoto) {
    const photoWithinRadius = isWithinZone(
      gpsFromPhoto.lat,
      gpsFromPhoto.lng,
      eligibility.task.lat,
      eligibility.task.lng,
      eligibility.task.radiusMeters / 1000,
    );
    if (!photoWithinRadius) {
      gpsMismatch = true;
      logger.warn(
        'GPS mismatch: body coordinates supplied but photo EXIF GPS is outside task radius',
        {
          bodyLat,
          bodyLng,
          photoLat: gpsFromPhoto.lat,
          photoLng: gpsFromPhoto.lng,
          taskLat: eligibility.task.lat,
          taskLng: eligibility.task.lng,
          radiusMeters: eligibility.task.radiusMeters,
        },
      );
    }
  }

  // Persist effective coordinates (body GPS takes precedence for storage when
  // there is no mismatch; photo GPS fills in when body is absent).
  const effectiveLat = bodyLat ?? gpsFromPhoto?.lat ?? null;
  const effectiveLng = bodyLng ?? gpsFromPhoto?.lng ?? null;

  type PersistResult =
    | { status: 404 | 400 | 403 | 409; error: string }
    | { status: 201; proof: { id: string } };

  const persisted: PersistResult = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) return { status: 404 as const, error: 'task not found' };
    if (task.status !== 'ACTIVE') {
      return { status: 400 as const, error: 'task is not active' };
    }

    const claim = await tx.taskClaim.findFirst({
      where: {
        taskId,
        userId,
        status: 'active',
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!claim) {
      return {
        status: 403 as const,
        error: 'active claim required to submit proof for this task',
      };
    }

    if (task.maxCompletions != null) {
      const completed = await tx.proof.count({
        where: { taskId, status: 'APPROVED' },
      });
      if (completed >= task.maxCompletions) {
        return { status: 409 as const, error: 'task has reached maximum completions' };
      }
    }

    const proof = await tx.proof.create({
      data: {
        userId,
        taskId,
        claimId: claim.id,
        status: 'PENDING',
        notes: gpsMismatch ? 'gps_photo_mismatch' : notes,
        lat: effectiveLat,
        lng: effectiveLng,
        photos: { create: preparedPhotos },
      },
    });
    return { status: 201 as const, proof };
  });

  if (persisted.status !== 201) {
    return res.status(persisted.status).json({ error: persisted.error });
  }
  const { proof } = persisted;

  // Only enqueue auto-verification when GPS is consistent.  A mismatch leaves
  // the proof in PENDING status for manual validator review.
  if (!gpsMismatch) {
    await enqueueVerification(proof.id, req.requestId);
  }

  const createdProof = await prisma.proof.findUnique({
    where: { id: proof.id },
    include: { photos: true, verifications: true },
  });

  return res.status(201).json(createdProof);
}

export async function getProof(req: Request, res: Response) {
  const proof = await prisma.proof.findUnique({
    where: { id: req.params.id },
    include: { photos: true, verifications: true },
  });

  if (!proof) {
    return res.status(404).json({ error: 'proof not found' });
  }

  if (proof.userId !== req.user!.userId && !(await isAdmin(req.user!.userId))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  return res.json(proof);
}

async function isAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return user?.role === 'admin';
}

export async function listPendingProofs(req: Request, res: Response) {
  const parsed = listPendingProofsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid query parameters', details: parsed.error.flatten() });
  }

  const page = parsed.data.page;
  const limit = Math.min(parsed.data.limit, MAX_PAGINATION_LIMIT);
  const skip = (page - 1) * limit;

  const where = parsed.data.status
    ? { status: parsed.data.status }
    : { status: { in: ['PENDING' as const, 'VERIFYING' as const] } };

  const [proofs, total] = await Promise.all([
    prisma.proof.findMany({
      where,
      include: {
        photos: true,
        user: { select: { id: true, wallet: true, name: true } },
        task: { select: { id: true, title: true, type: true } },
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    }),
    prisma.proof.count({ where }),
  ]);

  return res.json({
    data: proofs,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function reviewProof(req: Request, res: Response) {
  const parsed = reviewProofSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid request body', details: parsed.error.flatten() });
  }

  const proof = await prisma.proof.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, taskId: true, status: true },
  });
  if (!proof) {
    return res.status(404).json({ error: 'proof not found' });
  }
  if (proof.status === 'APPROVED' || proof.status === 'REJECTED') {
    return res.status(409).json({ error: 'proof already has a final verdict' });
  }

  const status = parsed.data.verdict === 'approved' ? 'APPROVED' : 'REJECTED';

  await prisma.$transaction([
    prisma.proof.update({ where: { id: proof.id }, data: { status } }),
    prisma.verification.create({
      data: {
        proofId: proof.id,
        verifierId: req.user!.userId,
        verdict: parsed.data.verdict,
        notes: parsed.data.notes,
      },
    }),
  ]);

  await notifyProofStatus(proof.userId, proof.id, status, req.requestId);

  if (status === 'APPROVED') {
    const completed = await completeTaskIfFull(proof.taskId);
    if (completed) {
      logger.info('Task reached capacity and was completed', { taskId: proof.taskId });
    }

    await enqueueRewardPayout(proof.id, req.requestId);
  }

  const updated = await prisma.proof.findUnique({
    where: { id: proof.id },
    include: { photos: true, verifications: true },
  });
  return res.json(updated);
}

export async function getUserProofs(req: Request, res: Response) {
  const userId = req.params.userId;

  if (userId !== req.user!.userId && !(await isAdmin(req.user!.userId))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const parsed = listProofsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid query parameters', details: parsed.error.flatten() });
  }

  const page = parsed.data.page;
  const limit = Math.min(parsed.data.limit, MAX_PAGINATION_LIMIT);
  const skip = (page - 1) * limit;

  const [proofs, total] = await Promise.all([
    prisma.proof.findMany({
      where: { userId },
      include: { photos: true, task: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.proof.count({ where: { userId } }),
  ]);

  return res.json({
    data: proofs,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
