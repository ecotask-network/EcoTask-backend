import request from "supertest";
import app from "../../src/app";
import jwt from "jsonwebtoken";
import path from "path";

jest.mock("../../src/utils/prisma", () => ({
  __esModule: true,
  default: {
    task: { findUnique: jest.fn() },
    proof: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    proofPhoto: { create: jest.fn() },
  },
}));

jest.mock("../../src/services/ipfsService", () => ({
  uploadToIPFS: jest.fn().mockResolvedValue("mock-cid-test"),
  uploadMultipleToIPFS: jest.fn(),
}));

import prisma from "../../src/utils/prisma";

const mockPrisma = prisma as unknown as {
  task: { findUnique: jest.Mock };
  proof: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
  };
  proofPhoto: { create: jest.Mock };
};

function userToken(): string {
  return jwt.sign({ userId: "user-id", wallet: "GUSER..." }, "dev-secret-change-in-production");
}

beforeEach(() => {
  jest.clearAllMocks();
});

const VALID_UUID = "00000000-0000-0000-0000-000000000001";

describe("Proof Routes", () => {
  describe("POST /proofs", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app)
        .post("/proofs")
        .field("taskId", VALID_UUID)
        .attach("photos", path.join(__dirname, "../fixtures/test-proof.jpg"));
      expect(res.status).toBe(401);
    });

    it("returns 404 when task does not exist", async () => {
      mockPrisma.task.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .post("/proofs")
        .set("Authorization", `Bearer ${userToken()}`)
        .field("taskId", VALID_UUID);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("task not found");
    });

    it("returns 400 when task is not active", async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ id: "task-1", status: "COMPLETED" });
      const res = await request(app)
        .post("/proofs")
        .set("Authorization", `Bearer ${userToken()}`)
        .field("taskId", VALID_UUID);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("task is not active");
    });

    it("returns 201 and creates proof with photo", async () => {
      mockPrisma.task.findUnique.mockResolvedValue({ id: "task-1", status: "ACTIVE" });
      mockPrisma.proof.create.mockResolvedValue({ id: "proof-1", userId: "user-id", taskId: "task-1", status: "PENDING" });
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: "proof-1",
        status: "PENDING",
        photos: [{ id: "photo-1", cid: "mock-cid-test", filename: "test-proof.jpg" }],
        verifications: [],
      });
      const res = await request(app)
        .post("/proofs")
        .set("Authorization", `Bearer ${userToken()}`)
        .field("taskId", VALID_UUID)
        .field("lat", "-1.2921")
        .field("lng", "36.8219")
        .attach("photos", path.join(__dirname, "../fixtures/test-proof.jpg"));
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("PENDING");
    });
  });

  describe("GET /proofs/:id", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).get("/proofs/some-id");
      expect(res.status).toBe(401);
    });

    it("returns proof with photos and verifications", async () => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: "proof-1",
        status: "PENDING",
        photos: [{ id: "photo-1", cid: "mock-cid", filename: "test.jpg" }],
        verifications: [],
      });
      const res = await request(app)
        .get("/proofs/proof-1")
        .set("Authorization", `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("proof-1");
      expect(res.body.photos).toHaveLength(1);
    });

    it("returns 404 for non-existent proof", async () => {
      mockPrisma.proof.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get("/proofs/non-existent")
        .set("Authorization", `Bearer ${userToken()}`);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /proofs/user/:userId", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).get("/proofs/user/some-user-id");
      expect(res.status).toBe(401);
    });

    it("returns paginated proofs for user", async () => {
      mockPrisma.proof.findMany.mockResolvedValue([
        { id: "proof-1", status: "APPROVED", photos: [], task: { title: "Plant Trees" } },
      ]);
      mockPrisma.proof.count.mockResolvedValue(1);
      const res = await request(app)
        .get("/proofs/user/user-id")
        .set("Authorization", `Bearer ${userToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta.total).toBe(1);
    });
  });
});
