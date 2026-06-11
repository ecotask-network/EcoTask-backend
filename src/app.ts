/// <reference path="./types/express.d.ts" />

import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import taskRoutes from "./routes/tasks.js";
import proofRoutes from "./routes/proofs.js";

if (process.env.NODE_ENV !== "test") {
  import("./workers/verificationWorker.js");
  import("./workers/rewardWorker.js");
}

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "ecotask-backend" });
});

app.use("/auth", authRoutes);
app.use("/users", userRoutes);
app.use("/tasks", taskRoutes);
app.use("/proofs", proofRoutes);

if (process.env.NODE_ENV !== "test") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`EcoTask backend running on http://localhost:${PORT}`);
  });
}

export default app;
