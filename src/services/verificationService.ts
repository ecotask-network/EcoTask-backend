import prisma from '../utils/prisma';
import { isWithinRadius } from './geoService';
import { hasMinimumResolution, isRecentlyCaptured, hasFutureCaptureSkew } from './photoService';

interface VerificationResult {
  verdict: 'approved' | 'rejected' | 'inconclusive';
  confidence: number;
  notes?: string;
}

export async function autoVerify(proofId: string): Promise<VerificationResult> {
  const proof = await prisma.proof.findUnique({
    where: { id: proofId },
    include: { task: true, photos: true },
  });
  if (!proof) throw new Error('Proof not found');

  const checks: { pass: boolean; weight: number; name: string }[] = [];

  // ── GPS location ────────────────────────────────────────────────────────────
  if (proof.lat && proof.lng && proof.task.lat && proof.task.lng) {
    const inRange = isWithinRadius(
      proof.lat,
      proof.lng,
      proof.task.lat,
      proof.task.lng,
      proof.task.radiusMeters,
    );
    checks.push({ pass: inRange, weight: 0.4, name: 'gps_location' });
  } else {
    checks.push({ pass: false, weight: 0.4, name: 'gps_location_missing' });
  }

  // ── Photos present ──────────────────────────────────────────────────────────
  checks.push({ pass: proof.photos.length > 0, weight: 0.15, name: 'photos_present' });

  // ── Photo resolution (decoded pixels, not EXIF) ─────────────────────────────
  checks.push({
    pass: proof.photos.some(hasMinimumResolution),
    weight: 0.1,
    name: 'photo_quality',
  });

  // ── Photo recency (EXIF timestamp within 7-day window) ──────────────────────
  checks.push({
    pass: proof.photos.some((photo) => isRecentlyCaptured(photo.capturedAt)),
    weight: 0.05,
    name: 'photo_recency',
  });

  // ── Timestamp skew (EXIF capturedAt must not be in the future relative to
  //    proof submission — physically impossible; indicates a forged timestamp) ──
  const proofCreatedAt = proof.createdAt ?? new Date();
  const hasSkewedTimestamp = proof.photos.some((photo) =>
    hasFutureCaptureSkew(photo.capturedAt, proofCreatedAt),
  );
  checks.push({
    pass: !hasSkewedTimestamp,
    weight: 0.05,
    name: 'photo_timestamp_not_forged',
  });

  // ── Duplicate-photo fraud check ─────────────────────────────────────────────
  const hashes = proof.photos.map((p) => p.sha256).filter((h): h is string => Boolean(h));
  let duplicated = false;
  if (hashes.length > 0) {
    const dupCount = await prisma.proofPhoto.count({
      where: { sha256: { in: hashes }, proofId: { not: proof.id } },
    });
    duplicated = dupCount > 0;
  }

  if (duplicated) {
    return {
      verdict: 'rejected',
      confidence: 0,
      notes: 'photo_reused_across_proofs',
    };
  }

  checks.push({ pass: true, weight: 0.1, name: 'photo_not_duplicate' });

  // ── Task expiry ─────────────────────────────────────────────────────────────
  if (proof.task.expiresAt) {
    const expired = new Date() > proof.task.expiresAt;
    checks.push({ pass: !expired, weight: 0.2, name: 'task_not_expired' });
  } else {
    checks.push({ pass: true, weight: 0.2, name: 'task_no_expiry' });
  }

  const score = checks.reduce((sum, c) => sum + (c.pass ? c.weight : 0), 0);

  if (score >= 0.7) return { verdict: 'approved', confidence: score };
  if (score >= 0.4) return { verdict: 'inconclusive', confidence: score };
  return {
    verdict: 'rejected',
    confidence: score,
    notes: checks
      .filter((c) => !c.pass)
      .map((c) => c.name)
      .join(', '),
  };
}
