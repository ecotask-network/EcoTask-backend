import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import config from "../config/default.js";

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing authorization header" });
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, config.jwt.secret) as { userId: string; wallet: string };
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
}
