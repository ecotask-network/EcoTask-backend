import { PrismaClient } from "@prisma/client";
import request from "supertest";
import app from "../../src/app";

describe("E2E: Full User Flow", () => {
  const prisma = new PrismaClient();
  let userToken: string;
  let userId: string;
  let taskId: string;
  let proofId: string;

  beforeAll(async () => {
    await prisma.verification.deleteMany();
    await prisma.proofPhoto.deleteMany();
    await prisma.proof.deleteMany();
    await prisma.task.deleteMany();
    await prisma.user.deleteMany();
  });

  it("1. User connects wallet and authenticates", async () => {
    const challengeRes = await request(app)
      .get("/auth/challenge")
      .query({ wallet: "GBMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCK" });
    expect(challengeRes.status).toBe(200);

    const loginRes = await request(app)
      .post("/auth/login")
      .send({
        wallet: "GBMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCK",
        signature: "mocksignature",
        challenge: challengeRes.body.challenge,
      });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.token).toBeDefined();
    userToken = loginRes.body.token;
    userId = loginRes.body.user.id;
  });

  it("2. Admin creates a task", async () => {
    const res = await request(app)
      .post("/tasks")
      .set("Authorization", `Bearer ${userToken}`)
      .send({
        title: "Plant 10 Trees in Nairobi",
        description: "Plant and care for 10 native trees in Karura Forest",
        type: "TREE_PLANTING",
        rewardAmount: 50,
        lat: -1.2921,
        lng: 36.8219,
        radiusMeters: 500,
        maxCompletions: 5,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    taskId = res.body.id;
  });

  it("3. User submits a proof with photo", async () => {
    const res = await request(app)
      .post("/proofs")
      .set("Authorization", `Bearer ${userToken}`)
      .field("taskId", taskId)
      .field("lat", -1.2900)
      .field("lng", 36.8200)
      .attach("photos", Buffer.from("fake-image-data"), "proof.jpg");
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    proofId = res.body.id;
  });

  it("4. Proof gets verified (poll until resolved)", async () => {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await request(app)
      .get(`/proofs/${proofId}`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(["APPROVED", "VERIFYING"]).toContain(res.body.status);
  });

  it("5. Rewards are recorded", async () => {
    const res = await request(app)
      .get(`/users/${userId}/impact`)
      .set("Authorization", `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
