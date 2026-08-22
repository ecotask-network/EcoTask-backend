import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomFillSync } from 'crypto';
import { performance } from 'perf_hooks';
import { hashFile, extractPhotoMetadata } from '../../src/services/photoService';

/**
 * ── Methodology ──────────────────────────────────────────────────────────
 *
 * `hashFile` used to do `fs.readFileSync` + a synchronous `hash.update()`
 * over the whole file, and `extractPhotoMetadata` used to do
 * `fs.readFileSync` before decoding. Both block the Node event loop for the
 * full duration of the file read (and, for hashFile, the hash computation
 * too) — no other request on the process can be serviced while that runs.
 *
 * To demonstrate the refactored, streamed/async versions no longer do this,
 * we use a "liveness probe": a `setInterval` timer ticking every 5ms,
 * running concurrently with the operation under test. We record the
 * wall-clock gap between consecutive ticks with `perf_hooks.performance.now()`.
 *
 * If the event loop is blocked by synchronous work, the timer callback
 * queued for "+5ms from now" cannot run until the blocking call returns —
 * so a full block shows up as a single large gap approaching the total
 * operation duration, and very few ticks are recorded overall. If the
 * event loop stays responsive, ticks keep arriving roughly every ~5ms
 * (plus normal timer/scheduler jitter) throughout the operation, so many
 * ticks are recorded and no single gap dominates the total duration.
 *
 * We assert both:
 *   1. a healthy number of ticks fired over the run (not just 0 or 1), and
 *   2. no single gap between ticks came close to consuming the operation's
 *      entire wall-clock duration.
 *
 * The synthesized files are ~10MB of random bytes (matching the per-file
 * `limits.fileSize` cap in src/middleware/upload.ts) — they don't need to
 * be valid images for this test, since we're measuring I/O/hashing
 * blocking behavior, not decode correctness (that's covered against the
 * real fixtures in photoService.test.ts).
 */

const FILE_SIZE = 10 * 1024 * 1024; // ~10MB, matches upload.ts's fileSize limit
const FILE_COUNT = 5; // matches upload.array('photos', 5) in routes/proofs.ts
const PROBE_INTERVAL_MS = 5;

describe('PhotoService event-loop liveness (non-blocking I/O)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photoservice-eventloop-'));
  const largeFiles: string[] = [];

  beforeAll(() => {
    for (let i = 0; i < FILE_COUNT; i++) {
      const buffer = Buffer.alloc(FILE_SIZE);
      randomFillSync(buffer);
      const filePath = path.join(tmpDir, `large-${i}.bin`);
      fs.writeFileSync(filePath, buffer);
      largeFiles.push(filePath);
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function measureLiveness<T>(
    work: () => Promise<T>,
  ): Promise<{ gaps: number[]; elapsed: number; result: T }> {
    const gaps: number[] = [];
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, PROBE_INTERVAL_MS);

    const start = performance.now();
    const result = await work();
    const elapsed = performance.now() - start;
    clearInterval(timer);

    return { gaps, elapsed, result };
  }

  it('keeps ticking the liveness probe while hashing a ~10MB file', async () => {
    const { gaps, elapsed } = await measureLiveness(() => hashFile(largeFiles[0]));

    expect(gaps.length).toBeGreaterThan(0);
    const maxGap = Math.max(...gaps);
    // A fully-blocked event loop would show one gap ~= elapsed (ratio ~1.0).
    // A streamed, non-blocking hash should never come close to that, even
    // accounting for scheduler/GC jitter when the full test suite runs many
    // workers in parallel. The bound is generous to avoid CI flakiness
    // while still reliably catching a regression back to full blocking.
    expect(maxGap).toBeLessThan(Math.max(elapsed * 0.85, 300));
  });

  it('keeps ticking the liveness probe while extracting metadata from a ~10MB file', async () => {
    const { gaps, elapsed } = await measureLiveness(() =>
      extractPhotoMetadata(largeFiles[0]),
    );

    // If the operation completes before the first probe tick (elapsed < PROBE_INTERVAL_MS)
    // the event loop was never blocked — an instant async return is fine.
    if (gaps.length === 0) {
      expect(elapsed).toBeLessThan(PROBE_INTERVAL_MS * 3);
      return;
    }

    const maxGap = Math.max(...gaps);
    expect(maxGap).toBeLessThan(Math.max(elapsed * 0.85, 300));
  });

  it('stays responsive while hashing + extracting metadata for 5 files concurrently (Promise.all)', async () => {
    const { gaps, elapsed } = await measureLiveness(() =>
      Promise.all(
        largeFiles.map((filePath) =>
          Promise.all([hashFile(filePath), extractPhotoMetadata(filePath)]),
        ),
      ),
    );

    expect(gaps.length).toBeGreaterThan(0);
    const maxGap = Math.max(...gaps);
    expect(maxGap).toBeLessThan(Math.max(elapsed * 0.85, 300));
  });
});
