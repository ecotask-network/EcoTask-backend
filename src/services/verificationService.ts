import prisma from "../utils/prisma";
import { isWithinRadius } from "./geoService";

interface VerificationResult {
  verdict: "approved" | "rejected" | "inconclusive";
  confidence: number;
  notes?: string;
}

export async function autoVerify(proofId: string): Promise<VerificationResult> {
  const proof = await prisma.proof.findUnique({
    where: { id: proofId },
    include: { task: true, photos: true },
  });
  if (!proof) throw new Error("Proof not found");

  const checks: { pass: boolean; weight: number; name: string }[] = [];

  if (proof.lat && proof.lng && proof.task.lat && proof.task.lng) {
    const inRange = isWithinRadius(
      proof.lat, proof.lng,
      proof.task.lat, proof.task.lng,
      proof.task.radiusMeters
    );
    checks.push({ pass: inRange, weight: 0.4, name: "gps_location" });
  } else {
    checks.push({ pass: false, weight: 0.4, name: "gps_location_missing" });
  }

  checks.push({ pass: proof.photos.length > 0, weight: 0.2, name: "photos_present" });

  checks.push({ pass: true, weight: 0.1, name: "photo_quality" });

  if (proof.task.expiresAt) {
    const expired = new Date() > proof.task.expiresAt;
    checks.push({ pass: !expired, weight: 0.3, name: "task_not_expired" });
  } else {
    checks.push({ pass: true, weight: 0.3, name: "task_no_expiry" });
  }

  const score = checks.reduce((sum, c) => sum + (c.pass ? c.weight : 0), 0);

  if (score >= 0.7) return { verdict: "approved", confidence: score };
  if (score >= 0.4) return { verdict: "inconclusive", confidence: score };
  return { verdict: "rejected", confidence: score, notes: checks.filter(c => !c.pass).map(c => c.name).join(", ") };
}
