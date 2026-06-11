import { autoVerify } from "../../src/services/verificationService";
import { isWithinRadius } from "../../src/services/geoService";

jest.mock("../../src/utils/prisma", () => ({
  __esModule: true,
  default: {
    proof: {
      findUnique: jest.fn(),
    },
  },
}));

import prisma from "../../src/utils/prisma";

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock };
};

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Plant Trees",
    lat: -1.2921,
    lng: 36.8219,
    radiusMeters: 100,
    expiresAt: null,
    rewardAmount: 50,
    rewardToken: "ECO",
    ...overrides,
  };
}

describe("VerificationService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("approves proof with valid GPS and photos", async () => {
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: "proof-1",
      lat: -1.2921,
      lng: 36.8219,
      photos: [{ id: "photo-1", cid: "cid-1", filename: "test.jpg" }],
      task: makeTask(),
    });

    const result = await autoVerify("proof-1");
    expect(result.verdict).toBe("approved");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("rejects proof with no GPS, no photos, and expired task", async () => {
    const yesterday = new Date(Date.now() - 86400000);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: "proof-2",
      lat: null,
      lng: null,
      photos: [],
      task: makeTask({ expiresAt: yesterday }),
    });

    const result = await autoVerify("proof-2");
    expect(result.verdict).toBe("rejected");
    expect(result.confidence).toBeLessThan(0.4);
  });

  it("returns inconclusive for partial data (GPS but no photos, expired)", async () => {
    const yesterday = new Date(Date.now() - 86400000);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: "proof-3",
      lat: -1.2921,
      lng: 36.8219,
      photos: [],
      task: makeTask({ expiresAt: yesterday }),
    });

    const result = await autoVerify("proof-3");
    expect(result.verdict).toBe("inconclusive");
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    expect(result.confidence).toBeLessThan(0.7);
  });

  it("returns inconclusive for proof outside GPS radius", async () => {
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: "proof-4",
      lat: 0.0,
      lng: 0.0,
      photos: [{ id: "photo-1" }],
      task: makeTask(),
    });

    const result = await autoVerify("proof-4");
    expect(result.verdict).toBe("inconclusive");
  });

  it("returns inconclusive for expired task with valid GPS but no photos", async () => {
    const yesterday = new Date(Date.now() - 86400000);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: "proof-5",
      lat: -1.2921,
      lng: 36.8219,
      photos: [],
      task: makeTask({ expiresAt: yesterday }),
    });

    const result = await autoVerify("proof-5");
    expect(result.verdict).toBe("inconclusive");
  });
});
