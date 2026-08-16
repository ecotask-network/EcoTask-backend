/**
 * Fixture generator: creates forged-exif.jpg in this directory.
 *
 * The output is a valid 10×10 JPEG whose EXIF PixelXDimension / PixelYDimension
 * fields claim 4000×3000.  image-size will still return 10×10 (reads SOF0 marker);
 * exifreader will report 4000×3000 (reads EXIF IFD).
 *
 * Run once and commit the binary:
 *   npx ts-node tests/fixtures/generate-fixtures.ts
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Minimal JFIF JPEG: 10 × 10 pixels, all black, no colour data beyond header.
// We embed a hand-crafted EXIF APP1 segment that overrides PixelXDimension /
// PixelYDimension to 4000 / 3000 so exifreader reads the forged values.
// ---------------------------------------------------------------------------

/** Write a big-endian 16-bit value into an existing Buffer. */
function writeU16BE(buf: Buffer, offset: number, value: number): void {
  buf[offset] = (value >> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

/** Write a big-endian 32-bit value into an existing Buffer. */
function writeU32BE(buf: Buffer, offset: number, value: number): void {
  buf[offset] = (value >> 24) & 0xff;
  buf[offset + 1] = (value >> 16) & 0xff;
  buf[offset + 2] = (value >> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function buildExifApp1(claimedWidth: number, claimedHeight: number): Buffer {
  // We build a minimal Exif IFD with two SHORT entries:
  //   Tag 0xA002  PixelXDimension  → claimedWidth
  //   Tag 0xA003  PixelYDimension  → claimedHeight
  //
  // EXIF structure (big-endian / MM):
  //   'Exif\0\0'  (6 bytes)  — required prefix inside APP1 payload
  //   'MM'        (2 bytes)  — byte order mark (big-endian)
  //   0x002A      (2 bytes)  — TIFF magic
  //   0x00000008  (4 bytes)  — offset to first IFD
  //   entry count (2 bytes)  — 2 entries
  //   [entry 1]   (12 bytes)
  //   [entry 2]   (12 bytes)
  //   0x00000000  (4 bytes)  — next IFD offset (none)

  const IFD_ENTRY_SIZE = 12;
  const NUM_ENTRIES = 2;
  const tiffHeaderSize = 8; // MM + magic + IFD offset
  const ifdSize = 2 + NUM_ENTRIES * IFD_ENTRY_SIZE + 4; // count + entries + next-ifd
  const payloadSize = 6 + tiffHeaderSize + ifdSize; // 'Exif\0\0' + tiff + ifd

  const payload = Buffer.alloc(payloadSize, 0);
  let o = 0;

  // Exif header
  payload.write('Exif\0\0', o, 'binary');
  o += 6;

  // TIFF header (big-endian)
  payload.write('MM', o, 'binary'); o += 2;
  writeU16BE(payload, o, 0x002a); o += 2;
  writeU32BE(payload, o, 0x00000008); o += 4; // IFD starts right after header

  // IFD entry count
  writeU16BE(payload, o, NUM_ENTRIES); o += 2;

  // Entry 1: PixelXDimension (0xA002), type SHORT (3), count 1, value claimedWidth
  writeU16BE(payload, o, 0xa002); o += 2;  // tag
  writeU16BE(payload, o, 3);     o += 2;  // type SHORT
  writeU32BE(payload, o, 1);     o += 4;  // count
  writeU16BE(payload, o, claimedWidth); o += 2;
  writeU16BE(payload, o, 0);     o += 2;  // padding

  // Entry 2: PixelYDimension (0xA003), type SHORT (3), count 1, value claimedHeight
  writeU16BE(payload, o, 0xa003); o += 2;
  writeU16BE(payload, o, 3);     o += 2;
  writeU32BE(payload, o, 1);     o += 4;
  writeU16BE(payload, o, claimedHeight); o += 2;
  writeU16BE(payload, o, 0);     o += 2;

  // Next IFD offset (none)
  writeU32BE(payload, o, 0); // o += 4 — end

  // APP1 segment: marker + length (includes 2-byte length field itself) + payload
  const segmentLength = 2 + payloadSize;
  const app1 = Buffer.alloc(2 + segmentLength);
  let s = 0;
  writeU16BE(app1, s, 0xffe1); s += 2; // APP1 marker
  writeU16BE(app1, s, segmentLength); s += 2;
  payload.copy(app1, s);

  return app1;
}

function buildMinimalJpeg(width: number, height: number, exifApp1: Buffer): Buffer {
  const w = width;
  const h = height;

  // SOI
  const soi = Buffer.from([0xff, 0xd8]);

  // JFIF APP0
  const jfif = Buffer.from([
    0xff, 0xe0,       // APP0 marker
    0x00, 0x10,       // length = 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // 'JFIF\0'
    0x01, 0x01,       // version 1.1
    0x00,             // aspect ratio units: none
    0x00, 0x01,       // Xdensity = 1
    0x00, 0x01,       // Ydensity = 1
    0x00, 0x00,       // thumbnail size 0×0
  ]);

  // DQT — minimal all-1s quantisation table (luminance, table id 0)
  const dqt = Buffer.alloc(69, 0);
  dqt[0] = 0xff; dqt[1] = 0xdb;
  dqt[2] = 0x00; dqt[3] = 0x43; // length = 67
  dqt[4] = 0x00;                 // precision 0 + table id 0
  dqt.fill(1, 5, 69);            // all quantisation values = 1

  // SOF0 — baseline DCT, 8-bit, 1 component (greyscale)
  const sof0 = Buffer.from([
    0xff, 0xc0,                         // SOF0 marker
    0x00, 0x0b,                         // length = 11
    0x08,                               // precision 8-bit
    (h >> 8) & 0xff, h & 0xff,          // height
    (w >> 8) & 0xff, w & 0xff,          // width  ← what image-size reads
    0x01,                               // 1 component
    0x01, 0x11, 0x00,                   // component: Y, 1×1 sampling, QT 0
  ]);

  // DHT — minimal Huffman table (DC, table 0)
  const dht = Buffer.from([
    0xff, 0xc4,
    0x00, 0x1f, // length = 31
    0x00,       // table class 0 (DC) + id 0
    0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, // counts per length 1-8
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,        // counts 9-15
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, // values
  ]);

  // SOS header + minimal entropy-coded segment (single black 8×8 block repeated)
  const sos = Buffer.from([
    0xff, 0xda,                // SOS marker
    0x00, 0x08,                // length = 8
    0x01,                      // 1 component
    0x01, 0x00,                // component Y, DC table 0 / AC table 0
    0x00, 0x3f, 0x00,          // Ss=0, Se=63, Ah/Al=0
  ]);

  // Minimal encoded bitstream: DC coefficient 0, no AC coefficients (all black)
  // EOB = 1 bit 1 in baseline, encoded as 0xF0 with pad bits — simplest valid:
  const ecsBytes = Buffer.from([0x7f, 0xfe]); // valid all-zero 8×8 block (approx)

  // EOI
  const eoi = Buffer.from([0xff, 0xd9]);

  return Buffer.concat([soi, jfif, exifApp1, dqt, sof0, dht, sos, ecsBytes, eoi]);
}

// ── Main ────────────────────────────────────────────────────────────────────

const REAL_WIDTH = 10;
const REAL_HEIGHT = 10;
const FORGED_WIDTH = 4000;
const FORGED_HEIGHT = 3000;

const exifApp1 = buildExifApp1(FORGED_WIDTH, FORGED_HEIGHT);
const jpeg = buildMinimalJpeg(REAL_WIDTH, REAL_HEIGHT, exifApp1);

const outPath = path.join(__dirname, 'forged-exif.jpg');
fs.writeFileSync(outPath, jpeg);
console.log(`Written ${jpeg.length} bytes to ${outPath}`);
console.log(`Real size: ${REAL_WIDTH}×${REAL_HEIGHT}  |  EXIF claims: ${FORGED_WIDTH}×${FORGED_HEIGHT}`);
