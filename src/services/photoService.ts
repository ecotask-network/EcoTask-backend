import ExifReader from 'exifreader';
import fs from 'fs';
import { createHash } from 'crypto';

export const MIN_PHOTO_WIDTH = 480;
export const MIN_PHOTO_HEIGHT = 480;
export const MAX_PHOTO_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PhotoMetadata {
  width: number | null;
  height: number | null;
  capturedAt: Date | null;
}

export function hashFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

function parseDimension(tags: ExifReader.Tags, keys: string[]): number | null {
  for (const key of keys) {
    const tag = tags[key];
    if (!tag) continue;
    const raw = tag.value as unknown;
    if (Array.isArray(raw)) {
      const n = Number(raw[0]);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
    const described = Number((tag as { description?: string }).description);
    if (Number.isFinite(described) && described > 0) return Math.round(described);
  }
  return null;
}

function parseCaptureTime(tags: ExifReader.Tags): Date | null {
  for (const key of ['DateTimeOriginal', 'CreateDate', 'DateTime']) {
    const tag = tags[key];
    if (!tag) continue;
    const raw = tag.description ?? (tag.value as unknown);
    if (typeof raw !== 'string') continue;
    const match = raw.match(/(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!match) continue;
    const [, y, mo, d, h, mi, s] = match;
    const date = new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    );
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

export async function extractPhotoMetadata(filePath: string): Promise<PhotoMetadata> {
  try {
    const tags = ExifReader.load(fs.readFileSync(filePath));
    return {
      width: parseDimension(tags, [
        'PixelXDimension',
        'Exif Image Width',
        'ImageWidth',
        'Image Width',
      ]),
      height: parseDimension(tags, [
        'PixelYDimension',
        'Exif Image Height',
        'ImageLength',
        'Image Height',
      ]),
      capturedAt: parseCaptureTime(tags),
    };
  } catch {
    return { width: null, height: null, capturedAt: null };
  }
}

export function hasMinimumResolution(photo: {
  width?: number | null;
  height?: number | null;
}): boolean {
  return (
    photo.width != null &&
    photo.height != null &&
    photo.width >= MIN_PHOTO_WIDTH &&
    photo.height >= MIN_PHOTO_HEIGHT
  );
}

export function isRecentlyCaptured(capturedAt?: Date | null): boolean {
  if (!capturedAt) return false;
  const age = Date.now() - capturedAt.getTime();
  return age >= 0 && age <= MAX_PHOTO_AGE_MS;
}
