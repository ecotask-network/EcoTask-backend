import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import ExifReader from 'exifreader';
import { imageSize } from 'image-size';
import {
  hashFile,
  extractPhotoMetadata,
  hasMinimumResolution,
  isRecentlyCaptured,
  hasFutureCaptureSkew,
  isCorruptPhoto,
  MIN_PHOTO_WIDTH,
  MAX_PHOTO_AGE_MS,
  MAX_CAPTURE_SKEW_MS,
} from '../../src/services/photoService';

const FIXTURE = path.join(__dirname, '../fixtures/test-proof.jpg');
const FORGED_EXIF = path.join(__dirname, '../fixtures/forged-exif.jpg');

describe('PhotoService', () => {
  it('hashes a file to a stable sha256 hex digest', async () => {
    const first = await hashFile(FIXTURE);
    const second = await hashFile(FIXTURE);
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
    expect(metadata.isCorrupt).toBe(false);
  });

  it('returns isCorrupt: true and null metadata for missing files', async () => {
    const metadata = await extractPhotoMetadata('/tmp/does-not-exist.jpg');
    expect(metadata).toEqual({
      width: null,
      height: null,
      capturedAt: null,
      gpsLat: null,
      gpsLng: null,
      isCorrupt: true,
    });
    expect(isCorruptPhoto(metadata)).toBe(true);
  });

  it('identifies corrupt / non-image files as isCorrupt: true', async () => {
    const tmpFile = path.join(path.dirname(FIXTURE), 'temp-corrupt.bin');
    fs.writeFileSync(tmpFile, Buffer.from('this is not an image file'));
    try {
      const metadata = await extractPhotoMetadata(tmpFile);
      expect(metadata).toEqual({
        width: null,
        height: null,
        capturedAt: null,
        gpsLat: null,
        gpsLng: null,
        isCorrupt: true,
      });
      expect(isCorruptPhoto(metadata)).toBe(true);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('distinguishes legitimate image without EXIF from corrupt file', async () => {
    // 1x1 minimal PNG without any EXIF
    const minimalPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const tmpFile = path.join(path.dirname(FIXTURE), 'temp-no-exif.png');
    fs.writeFileSync(tmpFile, minimalPng);
    try {
      const metadata = await extractPhotoMetadata(tmpFile);
      expect(metadata.isCorrupt).toBe(false);
      expect(metadata.width).toBe(1);
      expect(metadata.height).toBe(1);
      expect(metadata.capturedAt).toBeNull();
      expect(metadata.gpsLat).toBeNull();
      expect(metadata.gpsLng).toBeNull();
      expect(isCorruptPhoto(metadata)).toBe(false);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('isCorruptPhoto helper returns true for null dimensions or isCorrupt flag', () => {
    expect(isCorruptPhoto({ width: null, height: null })).toBe(true);
    expect(isCorruptPhoto({ width: 1000, height: null })).toBe(true);
    expect(isCorruptPhoto({ width: null, height: 1000 })).toBe(true);
    expect(isCorruptPhoto({ isCorrupt: true, width: 1000, height: 1000 })).toBe(true);
    expect(isCorruptPhoto({ isCorrupt: false, width: 1000, height: 1000 })).toBe(false);
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

  // ── Identical-output regression: async streaming vs. direct sync decode ────
  // hashFile/extractPhotoMetadata were refactored from `fs.readFileSync` +
  // synchronous hashing/decoding to streamed/async I/O (see photoService.ts).
  // These tests assert the new async code paths produce byte-identical
  // results to a direct, independently-computed synchronous reference
  // (the same primitives the old implementation used), so the refactor is
  // a pure performance change with no behavioral drift.
  describe('async implementation matches a direct synchronous reference decode', () => {
    it('hashFile matches a plain sha256(readFileSync(...)) of test-proof.jpg', async () => {
      const referenceHash = createHash('sha256')
        .update(fs.readFileSync(FIXTURE))
        .digest('hex');
      const result = await hashFile(FIXTURE);
      expect(result).toBe(referenceHash);
    });

    it('hashFile matches a plain sha256(readFileSync(...)) of forged-exif.jpg', async () => {
      const referenceHash = createHash('sha256')
        .update(fs.readFileSync(FORGED_EXIF))
        .digest('hex');
      const result = await hashFile(FORGED_EXIF);
      expect(result).toBe(referenceHash);
    });

    it('extractPhotoMetadata matches direct image-size + exifreader decode for test-proof.jpg', async () => {
      const buffer = fs.readFileSync(FIXTURE);
      const referenceDimensions = imageSize(buffer);
      const referenceTags = ExifReader.load(buffer);

      const metadata = await extractPhotoMetadata(FIXTURE);

      expect(metadata.width).toBe(referenceDimensions.width ?? null);
      expect(metadata.height).toBe(referenceDimensions.height ?? null);

      if (referenceTags.GPSLatitude && referenceTags.GPSLongitude) {
        expect(metadata.gpsLat).toBeCloseTo(
          parseFloat(referenceTags.GPSLatitude.description as string),
        );
        expect(metadata.gpsLng).toBeCloseTo(
          parseFloat(referenceTags.GPSLongitude.description as string),
        );
      } else {
        expect(metadata.gpsLat).toBeNull();
        expect(metadata.gpsLng).toBeNull();
      }
    });

    it('extractPhotoMetadata matches direct image-size decode for forged-exif.jpg (real 10×10, not forged 4000×3000)', async () => {
      const buffer = fs.readFileSync(FORGED_EXIF);
      const referenceDimensions = imageSize(buffer);

      const metadata = await extractPhotoMetadata(FORGED_EXIF);

      expect(metadata.width).toBe(referenceDimensions.width ?? null);
      expect(metadata.height).toBe(referenceDimensions.height ?? null);
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
