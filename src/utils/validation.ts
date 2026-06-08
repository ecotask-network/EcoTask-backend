import { z } from "zod";

export const loginSchema = z.object({
  wallet: z.string().length(56),
  signature: z.string().min(10),
  challenge: z.string().min(10),
});

export const updateUserSchema = z.object({
  name: z.string().max(100).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
});
