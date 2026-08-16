import ExifReader from 'exifreader';
import fs from 'fs';
import { createHash } from 'crypto';
import { imageSize } from 'image-size';

export const MIN_PHOTO_WIDTH = 480;
export const MIN_PHOTO_HEIGHT = 480;
export const MAX_PHOTO_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Maximum allowed difference between the EXIF capture timestamp and the
 * server-side proof submission time. A photo whose EXIF DateTimeOriginal is
 * more than this far in the FUTURE relative to submission is physically
 * impossible and indicates a forged timestamp.
 */
export const MAX_CAPTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes

export interface PhotoMetadata {
  /** Actual decoded pixel width — never from EXIF. */
  width: number | null;
  /** Actual decoded pixel height — never from EXIF. */
  height: number | null;
  capturedAt: Date | null;
  /** GPS latitude parsed from EXIF, if present. */
  gpsLat: number | null;
  /** GPS longitude parsed from EXIF, if present. */
  gpsLng: number | null;
}

export function hashFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Decode the ACTUAL pixel dimensions of an image file.
 * Uses the image-size library which reads native image headers (JPEG SOF,
 * PNG IHDR, WebP VP8, etc.) — completely independent of EXIF metadata.
 * A 10×10 JPEG with PixelXDimension=4000 in its EXIF will return {width:10, height:10}.
 */
function decodeActualDimensions(buffer: Buffer): { width: number | null; height: number | null } {
  try {
    const result = imageSize(buffer);
    const width = result.width != null && result.width > 0 ? result.width : null;
    const height = result.height != null && result.height > 0 ? result.height : null;
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
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

function parseExifGps(tags: ExifReader.Tags): { gpsLat: number | null; gpsLng: number | null } {
  try {
    if (!tags.GPSLatitude || !tags.GPSLongitude) return { gpsLat: null, gpsLng: null };
    const lat = parseFloat(tags.GPSLatitude.description as string);
    const lng = parseFloat(tags.GPSLongitude.description as string);
    if (isNaN(lat) || isNaN(lng)) return { gpsLat: null, gpsLng: null };
    return { gpsLat: lat, gpsLng: lng };
  } catch {
    return { gpsLat: null, gpsLng: null };
  }
}

export async function extractPhotoMetadata(filePath: string): Promise<PhotoMetadata> {
  try {
    const buffer = fs.readFileSync(filePath);
    // Decode real dimensions from image headers — never trust EXIF for this.
    const { width, height } = decodeActualDimensions(buffer);
    const tags = ExifReader.load(buffer);
    return {
      width,
      height,
      capturedAt: parseCaptureTime(tags),
      ...parseExifGps(tags),
    };
  } catch {
    return { width: null, height: null, capturedAt: null, gpsLat: null, gpsLng: null };
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

/**
 * Returns true if the EXIF capture timestamp is suspiciously far in the future
 * relative to a given reference time (typically the server-side proof.createdAt).
 * A positive skew beyond MAX_CAPTURE_SKEW_MS is physically impossible and
 * indicates a forged DateTimeOriginal field.
 */
export function hasFutureCaptureSkew(capturedAt: Date | null, referenceTime: Date): boolean {
  if (!capturedAt) return false;
  return capturedAt.getTime() - referenceTime.getTime() > MAX_CAPTURE_SKEW_MS;
}
