import fs from 'fs';
import path from 'path';
import {
  hashFile,
  extractPhotoMetadata,
  hasMinimumResolution,
  isRecentlyCaptured,
  MIN_PHOTO_WIDTH,
  MAX_PHOTO_AGE_MS,
} from '../../src/services/photoService';

const FIXTURE = path.join(__dirname, '../fixtures/test-proof.jpg');

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
  });

  it('returns null metadata for missing files', async () => {
    const metadata = await extractPhotoMetadata('/tmp/does-not-exist.jpg');
    expect(metadata).toEqual({ width: null, height: null, capturedAt: null });
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
});
