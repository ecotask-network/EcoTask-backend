/// <reference path="./types/express.d.ts" />

import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import taskRoutes from "./routes/tasks.js";
import proofRoutes from "./routes/proofs.js";
import healthRoutes from "./routes/health.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { apiLimiter, authLimiter, proofLimiter } from "./middleware/rateLimit.js";
import { sanitizeInput } from "./middleware/sanitize.js";
import prisma from "./utils/prisma.js";
import logger from "./utils/logger.js";

if (process.env.NODE_ENV !== "test") {
  import("./workers/verificationWorker.js");
  import("./workers/rewardWorker.js");
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(sanitizeInput);

app.use("/api", apiLimiter);

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "ecotask-backend" });
});

app.use("/health", healthRoutes);
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
  const server = app.listen(PORT, () => {
    logger.info(`EcoTask backend running on http://localhost:${PORT}`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, starting graceful shutdown`);
    server.close(async () => {
      logger.info("HTTP server closed");
      await prisma.$disconnect();
      logger.info("Prisma client disconnected");
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export default app;
