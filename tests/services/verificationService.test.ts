import { autoVerify } from '../../src/services/verificationService';

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    proof: {
      findUnique: jest.fn(),
    },
    proofPhoto: {
      count: jest.fn(),
    },
  },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock };
  proofPhoto: { count: jest.Mock };
};

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Plant Trees',
    lat: -1.2921,
    lng: 36.8219,
    radiusMeters: 100,
    expiresAt: null,
    rewardAmountMicros: 500000000n,
    rewardToken: 'ECO',
    ...overrides,
  };
}

/**
 * Score weights:
 *   gps_location              0.40
 *   photos_present            0.15
 *   photo_quality             0.10
 *   photo_recency             0.05
 *   photo_timestamp_not_forged 0.05  ← NEW
 *   photo_not_duplicate       0.10
 *   task_not_expired          0.20
 *   ─────────────────────────────
 *   Total possible            1.05
 *
 *   approved   ≥ 0.70
 *   inconclusive 0.40 – 0.69
 *   rejected   < 0.40
 */

describe('VerificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no duplicate photos
    mockPrisma.proofPhoto.count.mockResolvedValue(0);
  });

  it('approves proof with valid GPS and photos', async () => {
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-1',
      lat: -1.2921,
      lng: 36.8219,
      createdAt: new Date(),
      photos: [{ id: 'photo-1', cid: 'cid-1', filename: 'test.jpg' }],
      task: makeTask(),
    });

    const result = await autoVerify('proof-1');
    expect(result.verdict).toBe('approved');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('rejects proof with no GPS, no photos, and expired task', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-2',
      lat: null,
      lng: null,
      createdAt: new Date(),
      photos: [],
      task: makeTask({ expiresAt: yesterday }),
    });

    const result = await autoVerify('proof-2');
    expect(result.verdict).toBe('rejected');
    expect(result.confidence).toBeLessThan(0.4);
  });

  it('returns inconclusive for partial data (GPS but no photos, expired)', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-3',
      lat: -1.2921,
      lng: 36.8219,
      createdAt: new Date(),
      photos: [],
      task: makeTask({ expiresAt: yesterday }),
    });

    const result = await autoVerify('proof-3');
    expect(result.verdict).toBe('inconclusive');
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    expect(result.confidence).toBeLessThan(0.7);
  });

  it('returns inconclusive for proof outside GPS radius', async () => {
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-4',
      lat: 0.0,
      lng: 0.0,
      createdAt: new Date(),
      photos: [{ id: 'photo-1' }],
      task: makeTask(),
    });

    const result = await autoVerify('proof-4');
    expect(result.verdict).toBe('inconclusive');
  });

  it('returns inconclusive for expired task with valid GPS but no photos', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-5',
      lat: -1.2921,
      lng: 36.8219,
      createdAt: new Date(),
      photos: [],
      task: makeTask({ expiresAt: yesterday }),
    });

    const result = await autoVerify('proof-5');
    expect(result.verdict).toBe('inconclusive');
  });

  it('rejects a proof reusing a photo already submitted elsewhere', async () => {
    mockPrisma.proofPhoto.count.mockResolvedValue(1);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-6',
      lat: -1.2921,
      lng: 36.8219,
      createdAt: new Date(),
      photos: [
        {
          id: 'photo-1',
          cid: 'cid-1',
          filename: 'test.jpg',
          sha256: 'dup-hash',
          width: 1920,
          height: 1080,
          capturedAt: new Date(),
        },
      ],
      task: makeTask(),
    });

    const result = await autoVerify('proof-6');
    expect(result.verdict).toBe('rejected');
    expect(result.confidence).toBeLessThan(0.4);
  });

  it('approves a proof with high-resolution, recent, unique photos', async () => {
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-7',
      lat: -1.2921,
      lng: 36.8219,
      createdAt: new Date(),
      photos: [
        {
          id: 'photo-1',
          cid: 'cid-1',
          filename: 'test.jpg',
          sha256: 'unique-hash',
          width: 4032,
          height: 3024,
          capturedAt: new Date(),
        },
      ],
      task: makeTask(),
    });

    const result = await autoVerify('proof-7');
    expect(result.verdict).toBe('approved');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(mockPrisma.proofPhoto.count).toHaveBeenCalledWith({
      where: { sha256: { in: ['unique-hash'] }, proofId: { not: 'proof-7' } },
    });
  });

  it('penalizes photos lacking recent EXIF capture metadata (old but not future-forged)', async () => {
    // Photo taken 30 days ago: photo_recency FAILS (weight 0.05 lost)
    // photo_timestamp_not_forged PASSES (old is fine, only future is forged)
    // All other checks pass → score = 1.05 - 0.05 = 1.00
    const oldCapture = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const proofCreatedAt = new Date();
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-8',
      lat: -1.2921,
      lng: 36.8219,
      createdAt: proofCreatedAt,
      photos: [
        {
          id: 'photo-1',
          cid: 'cid-1',
          filename: 'test.jpg',
          sha256: 'stale-hash',
          width: 4032,
          height: 3024,
          capturedAt: oldCapture,
        },
      ],
      task: makeTask(),
    });

    const result = await autoVerify('proof-8');
    expect(result.verdict).toBe('approved');
    // photo_recency (0.05) fails; all other 6 checks pass: 1.05 - 0.05 = 1.00
    expect(result.confidence).toBe(1.0);
  });

  // ── NEW: Forged timestamp skew ───────────────────────────────────────────
  it('fails photo_timestamp_not_forged when EXIF capturedAt is in the future', async () => {
    // capturedAt is 10 minutes ahead of proof.createdAt — physically impossible.
    const proofCreatedAt = new Date();
    const futureCapture = new Date(proofCreatedAt.getTime() + 10 * 60 * 1000);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-9',
      lat: -1.2921,
      lng: 36.8219,
      createdAt: proofCreatedAt,
      photos: [
        {
          id: 'photo-1',
          cid: 'cid-1',
          filename: 'test.jpg',
          sha256: 'future-hash',
          width: 4032,
          height: 3024,
          capturedAt: futureCapture,
        },
      ],
      task: makeTask(),
    });

    const result = await autoVerify('proof-9');
    // photo_recency also fails (future date → age < 0 → isRecentlyCaptured returns false)
    // photo_timestamp_not_forged fails too.
    // Score: 0.40 + 0.15 + 0.10 + 0 + 0 + 0.10 + 0.20 = 0.95 → approved, but
    // with lower confidence than a clean proof.
    expect(result.notes).toBeUndefined(); // not rejected outright
    // More importantly, the skew check failed (confidence lower than fully-clean proof)
    expect(result.confidence).toBeLessThan(1.05);
    // Sanity: still above threshold for approval given good GPS
    expect(result.verdict).toBe('approved');
    // confidence = 1.05 - 0.05 (recency) - 0.05 (skew) = 0.95
    expect(result.confidence).toBe(0.95);
  });

  it('returns inconclusive for proof with forged future timestamp and missing GPS', async () => {
    const proofCreatedAt = new Date();
    const futureCapture = new Date(proofCreatedAt.getTime() + 60 * 60 * 1000); // 1 hour ahead
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-10',
      lat: null,
      lng: null,
      createdAt: proofCreatedAt,
      photos: [
        {
          id: 'photo-1',
          sha256: 'future-no-gps',
          width: 4032,
          height: 3024,
          capturedAt: futureCapture,
        },
      ],
      task: makeTask(),
    });

    const result = await autoVerify('proof-10');
    // gps_location_missing (0.40 lost) + photo_recency (0.05 lost) + timestamp_forged (0.05 lost)
    // Score: 0 + 0.15 + 0.10 + 0 + 0 + 0.10 + 0.20 = 0.55 → inconclusive
    expect(result.verdict).toBe('inconclusive');
    expect(result.confidence).toBe(0.55);
  });
});
