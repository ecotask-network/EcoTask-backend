/// <reference path="./types/express.d.ts" />

import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import taskRoutes from "./routes/tasks.js";
import proofRoutes from "./routes/proofs.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { apiLimiter, authLimiter, proofLimiter } from "./middleware/rateLimit.js";

if (process.env.NODE_ENV !== "test") {
  import("./workers/verificationWorker.js");
  import("./workers/rewardWorker.js");
}

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", apiLimiter);

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "ecotask-backend" });
});

app.use("/auth", authLimiter, authRoutes);
app.use("/users", userRoutes);
app.use("/tasks", taskRoutes);
app.use("/proofs", proofLimiter, proofRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(errorHandler);

if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`EcoTask backend running on http://localhost:${PORT}`);
  });
}

export default app;
