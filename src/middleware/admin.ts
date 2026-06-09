import { Request, Response, NextFunction } from "express";
import prisma from "../utils/prisma.js";

export async function adminMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: "authentication required" });
  }

  const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
  if (!user || user.role !== "admin") {
    return res.status(403).json({ error: "admin access required" });
  }

  next();
}
