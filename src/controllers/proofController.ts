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

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) {
    return res.status(404).json({ error: 'task not found' });
  }
  if (task.status !== 'ACTIVE') {
    return res.status(400).json({ error: 'task is not active' });
  }

  if (task.maxCompletions != null) {
    const completed = await prisma.proof.count({
      where: { taskId, status: 'APPROVED' },
    });
    if (completed >= task.maxCompletions) {
      return res.status(409).json({ error: 'task has reached maximum completions' });
    }
  }

  const proof = await prisma.proof.create({
    data: {
      userId: req.user!.userId,
      taskId,
      status: 'PENDING',
      notes,
    },
  });

  // GPS extracted from the first photo that carries EXIF GPS.  We collect it
  // alongside width/height in a single extractPhotoMetadata pass — no separate
  // EXIF load needed.
  let gpsFromPhoto: { lat: number; lng: number } | null = null;

  const files = req.files as Express.Multer.File[] | undefined;
  if (files && files.length > 0) {
    for (const file of files) {
      const [sha256, metadata] = await Promise.all([
        hashFile(file.path),
        extractPhotoMetadata(file.path),
      ]);

      // Capture the first photo's EXIF GPS for cross-checking below.
      if (!gpsFromPhoto && metadata.gpsLat != null && metadata.gpsLng != null) {
        gpsFromPhoto = { lat: metadata.gpsLat, lng: metadata.gpsLng };
      }

      const cid = await uploadToIPFS(file.path, file.filename);

      await prisma.proofPhoto.create({
        data: {
          proofId: proof.id,
          cid,
          filename: file.originalname,
          sha256,
          width: metadata.width,
          height: metadata.height,
          capturedAt: metadata.capturedAt,
        },
      });

      fs.promises.unlink(file.path).catch((err) => {
        logger.warn('Failed to clean up uploaded file', {
          err,
          path: file.path,
        });
      });
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
      task.lat,
      task.lng,
      task.radiusMeters / 1000,
    );
    if (!photoWithinRadius) {
      gpsMismatch = true;
      logger.warn('GPS mismatch: body coordinates supplied but photo EXIF GPS is outside task radius', {
        proofId: proof.id,
        bodyLat,
        bodyLng,
        photoLat: gpsFromPhoto.lat,
        photoLng: gpsFromPhoto.lng,
        taskLat: task.lat,
        taskLng: task.lng,
        radiusMeters: task.radiusMeters,
      });
    }
  }

  // Persist effective coordinates (body GPS takes precedence for storage when
  // there is no mismatch; photo GPS fills in when body is absent).
  const effectiveLat = bodyLat ?? gpsFromPhoto?.lat ?? null;
  const effectiveLng = bodyLng ?? gpsFromPhoto?.lng ?? null;

  const proofUpdateData: { lat?: number; lng?: number; notes?: string } = {};
  if (effectiveLat !== null && effectiveLng !== null) {
    proofUpdateData.lat = effectiveLat;
    proofUpdateData.lng = effectiveLng;
  }
  if (gpsMismatch) {
    proofUpdateData.notes = 'gps_photo_mismatch';
  }
  if (Object.keys(proofUpdateData).length > 0) {
    await prisma.proof.update({
      where: { id: proof.id },
      data: proofUpdateData,
    });
  }

  // Only enqueue auto-verification when GPS is consistent.  A mismatch leaves
  // the proof in PENDING status for manual validator review.
  if (!gpsMismatch) {
    await enqueueVerification(proof.id);
  }

  const result = await prisma.proof.findUnique({
    where: { id: proof.id },
    include: { photos: true, verifications: true },
  });

  return res.status(201).json(result);
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

  await notifyProofStatus(proof.userId, proof.id, status);

  if (status === 'APPROVED') {
    const completed = await completeTaskIfFull(proof.taskId);
    if (completed) {
      logger.info('Task reached capacity and was completed', { taskId: proof.taskId });
    }

    await enqueueRewardPayout(proof.id);
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
