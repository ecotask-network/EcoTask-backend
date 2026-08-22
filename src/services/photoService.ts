import ExifReader from 'exifreader';
import fs from 'fs';
import { createHash } from 'crypto';
import { pipeline } from 'stream/promises';
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

/**
 * Hash a file's contents with SHA-256, streaming it off disk in chunks
 * instead of buffering the whole file with `fs.readFileSync`. For a ~10MB
 * photo, a synchronous full-file read + hash blocks the Node event loop for
 * the entire operation, stalling every other in-flight request on the
 * process. `fs.createReadStream` + `stream/promises` `pipeline` reads and
 * hashes in small chunks, yielding to the event loop between chunks, so the
 * process keeps servicing other requests while a hash is in progress.
 */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Decode the ACTUAL pixel dimensions of an image file.
 * Uses the image-size library which reads native image headers (JPEG SOF,
 * PNG IHDR, WebP VP8, etc.) — completely independent of EXIF metadata.
 * A 10×10 JPEG with PixelXDimension=4000 in its EXIF will return {width:10, height:10}.
 */
function decodeActualDimensions(buffer: Buffer): {
  width: number | null;
  height: number | null;
} {
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

function parseExifGps(tags: ExifReader.Tags): {
  gpsLat: number | null;
  gpsLng: number | null;
} {
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

// The EXIF APP1 marker segment's length field is 16-bit, capping any single
// EXIF block at 65533 bytes per the Exif/JEITA spec — real camera metadata
// (DateTimeOriginal, GPS tags, etc.) always lives within that segment, near
// the start of the file, regardless of overall file size. `ExifReader.load`
// has no such bound built in: given the *entire* file buffer, it linearly
// scans looking for markers, and on data that never resolves into a
// recognized structure (e.g. a non-image upload) that scan runs the full
// buffer length — measured at ~15-18ms of uninterruptible synchronous CPU
// time on a 10MB buffer, long enough to starve the event loop of a chance to
// service any other in-flight request. Capping the slice we hand to
// ExifReader to a generous multiple of the spec max bounds that worst case
// to sub-millisecond, with no effect on real photos (whose EXIF segment is
// always well inside this window).
const MAX_EXIF_SCAN_BYTES = 128 * 1024;

export async function extractPhotoMetadata(filePath: string): Promise<PhotoMetadata> {
  try {
    // NOTE on the non-blocking tradeoff: `exifreader` and `image-size` are
    // both synchronous, in-memory-buffer APIs — decoding EXIF tags and
    // image headers is unavoidably a synchronous CPU-bound step with these
    // libraries, short of rewriting their internals (out of scope here).
    // What we *can* fix is (a) the file I/O feeding that buffer — `fs.readFileSync`
    // blocks the event loop for the full disk-read duration on top of the
    // decode, while `fs.promises.readFile` performs the read asynchronously via
    // libuv's thread pool and only resumes this function (and runs the sync
    // decode below) on a subsequent event-loop tick — and (b) bounding how
    // much data the synchronous decode itself has to churn through (see
    // `MAX_EXIF_SCAN_BYTES` above). So this is a partial fix — non-blocking
    // I/O plus a bounded worst-case decode, plus, when called concurrently
    // for multiple files (see proofController), the (now much shorter) sync
    // decode work for each file gets interleaved across event-loop ticks
    // instead of one file's read+decode fully blocking before the next
    // file's read even starts.
    const buffer = await fs.promises.readFile(filePath);
    // Decode real dimensions from image headers — never trust EXIF for this.
    const { width, height } = decodeActualDimensions(buffer);
    const exifSource =
      buffer.length > MAX_EXIF_SCAN_BYTES
        ? buffer.subarray(0, MAX_EXIF_SCAN_BYTES)
        : buffer;
    const tags = ExifReader.load(exifSource);
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
export function hasFutureCaptureSkew(
  capturedAt: Date | null,
  referenceTime: Date,
): boolean {
  if (!capturedAt) return false;
  return capturedAt.getTime() - referenceTime.getTime() > MAX_CAPTURE_SKEW_MS;
}
