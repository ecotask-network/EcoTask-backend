import request from "supertest";
import app from "../../src/app";
import { generateChallenge } from "../../src/services/stellarService";

const MOCK_WALLET = "GBMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCKMOCK00";

describe("Auth Routes", () => {
  it("GET /auth/challenge returns a challenge string for valid wallet", async () => {
    const res = await request(app)
      .get("/auth/challenge")
      .query({ wallet: MOCK_WALLET });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBeDefined();
    expect(typeof res.body.challenge).toBe("string");
  });

  it("GET /auth/challenge returns 400 for invalid wallet", async () => {
    const res = await request(app).get("/auth/challenge").query({ wallet: "short" });
    expect(res.status).toBe(400);
  });

  it("POST /auth/login fails with invalid signature", async () => {
    const challenge = generateChallenge();
    const res = await request(app)
      .post("/auth/login")
      .send({
        wallet: MOCK_WALLET,
        signature: "abcdef1234567890abcdef1234567890",
        challenge,
      });
    expect(res.status).toBe(401);
  });

  it("POST /auth/login returns 400 for missing fields", async () => {
    const res = await request(app).post("/auth/login").send({});
    expect(res.status).toBe(400);
  });
});
