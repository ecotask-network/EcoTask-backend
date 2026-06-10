import { Request, Response } from "express";
import ExifReader from "exifreader";
import fs from "fs";
import prisma from "../utils/prisma.js";
import { submitProofSchema } from "../utils/validation.js";
import { uploadToIPFS } from "../services/ipfsService.js";
import { isWithinZone } from "../services/geoService.js";

async function extractGps(filePath: string): Promise<{ lat: number; lng: number } | null> {
  const tags = await ExifReader.load(fs.readFileSync(filePath));
  if (tags.GPSLatitude && tags.GPSLongitude) {
    const lat = parseFloat(tags.GPSLatitude.description as string);
    const lng = parseFloat(tags.GPSLongitude.description as string);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat, lng };
  }
  return null;
}

export async function submitProof(req: Request, res: Response) {
  const parsed = submitProofSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid request body", details: parsed.error.flatten() });
  }

  const { taskId, lat: bodyLat, lng: bodyLng, notes } = parsed.data;

  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) {
    return res.status(404).json({ error: "task not found" });
  }
  if (task.status !== "ACTIVE") {
    return res.status(400).json({ error: "task is not active" });
  }

  const proof = await prisma.proof.create({
    data: {
      userId: req.user!.userId,
      taskId,
      status: "PENDING",
      notes,
    },
  });

  let gpsFromPhoto: { lat: number; lng: number } | null = null;

  const files = req.files as Express.Multer.File[] | undefined;
  if (files && files.length > 0) {
    for (const file of files) {
      if (!gpsFromPhoto) {
        gpsFromPhoto = await extractGps(file.path);
      }

      const cid = await uploadToIPFS(file.path, file.filename);

      await prisma.proofPhoto.create({
        data: {
          proofId: proof.id,
          cid,
          filename: file.originalname,
        },
      });
    }
  }

  const effectiveLat = bodyLat ?? gpsFromPhoto?.lat ?? null;
  const effectiveLng = bodyLng ?? gpsFromPhoto?.lng ?? null;

  if (effectiveLat !== null && effectiveLng !== null) {
    await prisma.proof.update({
      where: { id: proof.id },
      data: { lat: effectiveLat, lng: effectiveLng },
    });
  }

  if (bodyLat != null && bodyLng != null && gpsFromPhoto) {
    const withinRadius = isWithinZone(
      gpsFromPhoto.lat,
      gpsFromPhoto.lng,
      bodyLat,
      bodyLng,
      0.1,
    );
    if (!withinRadius) {
      console.warn(`GPS mismatch for proof ${proof.id}: body (${bodyLat},${bodyLng}) vs photo (${gpsFromPhoto.lat},${gpsFromPhoto.lng})`);
    }
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
    return res.status(404).json({ error: "proof not found" });
  }

  return res.json(proof);
}

export async function getUserProofs(req: Request, res: Response) {
  const userId = req.params.userId;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  const [proofs, total] = await Promise.all([
    prisma.proof.findMany({
      where: { userId },
      include: { photos: true, task: true },
      orderBy: { createdAt: "desc" },
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
