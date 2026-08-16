import fs from 'fs';
import path from 'path';
import {
  hashFile,
  extractPhotoMetadata,
  hasMinimumResolution,
  isRecentlyCaptured,
  hasFutureCaptureSkew,
  MIN_PHOTO_WIDTH,
  MAX_PHOTO_AGE_MS,
  MAX_CAPTURE_SKEW_MS,
} from '../../src/services/photoService';

const FIXTURE = path.join(__dirname, '../fixtures/test-proof.jpg');
const FORGED_EXIF = path.join(__dirname, '../fixtures/forged-exif.jpg');

describe('PhotoService', () => {
  it('hashes a file to a stable sha256 hex digest', () => {
    const first = hashFile(FIXTURE);
    const second = hashFile(FIXTURE);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(second);
  });

  it('extracts metadata without throwing on an arbitrary jpeg', async () => {
    const metadata = await extractPhotoMetadata(FIXTURE);
    expect(metadata).toHaveProperty('width');
    expect(metadata).toHaveProperty('height');
    expect(metadata).toHaveProperty('capturedAt');
    expect(metadata).toHaveProperty('gpsLat');
    expect(metadata).toHaveProperty('gpsLng');
  });

  it('returns null metadata for missing files', async () => {
    const metadata = await extractPhotoMetadata('/tmp/does-not-exist.jpg');
    expect(metadata).toEqual({
      width: null,
      height: null,
      capturedAt: null,
      gpsLat: null,
      gpsLng: null,
    });
  });

  it('flags photos below the minimum resolution', () => {
    expect(hasMinimumResolution({ width: MIN_PHOTO_WIDTH, height: 640 })).toBe(true);
    expect(hasMinimumResolution({ width: 320, height: 640 })).toBe(false);
    expect(hasMinimumResolution({ width: null, height: null })).toBe(false);
    expect(hasMinimumResolution({})).toBe(false);
  });

  it('flags photos captured outside the recency window', () => {
    expect(isRecentlyCaptured(new Date())).toBe(true);
    expect(isRecentlyCaptured(null)).toBe(false);
    expect(isRecentlyCaptured(undefined)).toBe(false);
    const old = new Date(Date.now() - MAX_PHOTO_AGE_MS - 1000);
    expect(isRecentlyCaptured(old)).toBe(false);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    expect(isRecentlyCaptured(future)).toBe(false);
  });

  // ── Forged-EXIF fixture tests ─────────────────────────────────────────────
  describe('forged-exif.jpg fixture', () => {
    it('fixture file exists and is readable', () => {
      expect(() => fs.readFileSync(FORGED_EXIF)).not.toThrow();
    });

    it('returns actual decoded dimensions (10×10), not EXIF-claimed (4000×3000)', async () => {
      const metadata = await extractPhotoMetadata(FORGED_EXIF);
      // image-size reads the real JPEG SOF0 marker → 10×10
      expect(metadata.width).toBe(10);
      expect(metadata.height).toBe(10);
    });

    it('fails hasMinimumResolution because real dimensions are 10×10', async () => {
      const metadata = await extractPhotoMetadata(FORGED_EXIF);
      expect(hasMinimumResolution(metadata)).toBe(false);
    });
  });

  // ── hasFutureCaptureSkew ──────────────────────────────────────────────────
  describe('hasFutureCaptureSkew', () => {
    const referenceTime = new Date('2026-01-01T12:00:00Z');

    it('returns false when capturedAt is null', () => {
      expect(hasFutureCaptureSkew(null, referenceTime)).toBe(false);
    });

    it('returns false when capturedAt equals reference time', () => {
      expect(hasFutureCaptureSkew(new Date(referenceTime), referenceTime)).toBe(false);
    });

    it('returns false when capturedAt is in the past', () => {
      const past = new Date(referenceTime.getTime() - 60_000);
      expect(hasFutureCaptureSkew(past, referenceTime)).toBe(false);
    });

    it('returns false when capturedAt is within the allowed skew window', () => {
      const slightlyAhead = new Date(referenceTime.getTime() + MAX_CAPTURE_SKEW_MS - 1);
      expect(hasFutureCaptureSkew(slightlyAhead, referenceTime)).toBe(false);
    });

    it('returns true when capturedAt is beyond MAX_CAPTURE_SKEW_MS in the future', () => {
      const forged = new Date(referenceTime.getTime() + MAX_CAPTURE_SKEW_MS + 1);
      expect(hasFutureCaptureSkew(forged, referenceTime)).toBe(true);
    });

    it('returns true for capturedAt 1 hour ahead of reference (clear forgery)', () => {
      const farFuture = new Date(referenceTime.getTime() + 60 * 60 * 1000);
      expect(hasFutureCaptureSkew(farFuture, referenceTime)).toBe(true);
    });
  });
});
