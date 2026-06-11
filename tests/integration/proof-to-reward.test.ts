import { autoVerify } from "../../src/services/verificationService";
import { submitReward } from "../../src/services/stellarService";

jest.mock("../../src/utils/prisma", () => ({
  __esModule: true,
  default: {
    proof: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    verification: {
      create: jest.fn(),
    },
    proofPhoto: {
      create: jest.fn(),
    },
  },
}));

import prisma from "../../src/utils/prisma";

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock; update: jest.Mock };
  verification: { create: jest.Mock };
};

describe("Proof-to-Reward Integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("approves valid proof and generates mock reward tx", async () => {
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: "proof-1",
      userId: "user-1",
      taskId: "task-1",
      status: "PENDING",
      lat: -1.2921,
      lng: 36.8219,
      photos: [{ id: "photo-1", cid: "cid-1" }],
      user: { wallet: "GC...USER..." },
      task: {
        id: "task-1",
        lat: -1.2921,
        lng: 36.8219,
        radiusMeters: 100,
        rewardAmount: 50,
        rewardToken: "ECO",
        expiresAt: null,
      },
    });

    const result = await autoVerify("proof-1");
    expect(result.verdict).toBe("approved");

    const txHash = await submitReward({
      userWallet: "GC...USER...",
      taskId: "task-1",
      amount: 50,
      assetCode: "ECO",
    });
    expect(txHash).toMatch(/^mock-tx-/);
  });

  it("rejects proof with missing GPS, no photos, and expired task", async () => {
    const yesterday = new Date(Date.now() - 86400000);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: "proof-2",
      lat: null,
      lng: null,
      photos: [],
      user: { wallet: "GC...USER..." },
      task: {
        id: "task-2",
        lat: -1.2921,
        lng: 36.8219,
        radiusMeters: 100,
        rewardAmount: 50,
        rewardToken: "ECO",
        expiresAt: yesterday,
      },
    });

    const result = await autoVerify("proof-2");
    expect(result.verdict).toBe("rejected");
    expect(result.notes).toMatch(/gps/);
  });
});
