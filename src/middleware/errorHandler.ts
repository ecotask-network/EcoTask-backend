import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import logger from "../utils/logger";

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  logger.error({ err, path: req.path, method: req.method });

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation error",
      details: err.errors.map((e) => ({ field: e.path.join("."), message: e.message })),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return res.status(409).json({ error: "Resource already exists" });
    if (err.code === "P2025") return res.status(404).json({ error: "Resource not found" });
  }

  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  if (err.message?.includes("File too large")) {
    return res.status(413).json({ error: "File too large" });
  }

  return res.status(500).json({ error: "Internal server error" });
}
