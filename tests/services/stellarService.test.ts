import { submitReward } from "../../src/services/stellarService";

describe("StellarService", () => {
  it("returns mock tx hash in dev mode", async () => {
    const result = await submitReward({ userWallet: "GC...", taskId: "123", amount: 50, assetCode: "ECO" });
    expect(result).toMatch(/^mock-tx-/);
  });
});
