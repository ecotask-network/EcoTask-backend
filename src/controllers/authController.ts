import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import config from "../config/default.js";
import { generateChallenge, verifyStellarSignature } from "../services/stellarService.js";
import { findOrCreateUser } from "../models/user.js";
import { loginSchema } from "../utils/validation.js";

const challenges = new Map<string, { challenge: string; expiresAt: number }>();

export function getChallenge(req: Request, res: Response) {
  const wallet = req.query.wallet as string;
  if (!wallet || wallet.length !== 56) {
    return res.status(400).json({ error: "invalid wallet address" });
  }

  const challenge = generateChallenge();
  challenges.set(wallet, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
  return res.json({ challenge });
}

export async function login(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid request body", details: parsed.error.flatten() });
  }

  const { wallet, signature, challenge } = parsed.data;

  const stored = challenges.get(wallet);
  if (!stored || stored.challenge !== challenge || stored.expiresAt < Date.now()) {
    return res.status(401).json({ error: "invalid or expired challenge" });
  }

  const message = `EcoTask login: ${challenge}`;
  const isValid = verifyStellarSignature(wallet, message, signature);
  if (!isValid) {
    return res.status(401).json({ error: "invalid signature" });
  }

  challenges.delete(wallet);

  const user = await findOrCreateUser(wallet);
  const token = jwt.sign(
    { userId: user.id, wallet: user.wallet },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn } as SignOptions,
  );

  return res.json({ token, user });
}

export function verify(req: Request, res: Response) {
  return res.json({ user: req.user });
}
