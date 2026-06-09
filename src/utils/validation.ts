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

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.string().min(1).max(50),
  rewardAmount: z.number().positive(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  expiresAt: z.string().datetime().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  type: z.string().min(1).max(50).optional(),
  rewardAmount: z.number().positive().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  status: z.enum(["ACTIVE", "COMPLETED", "EXPIRED"]).optional(),
  expiresAt: z.string().datetime().optional(),
});

export const listTasksQuerySchema = z.object({
  type: z.string().optional(),
  status: z.string().optional(),
  minReward: z.coerce.number().optional(),
  maxReward: z.coerce.number().optional(),
  swLat: z.coerce.number().min(-90).max(90).optional(),
  swLng: z.coerce.number().min(-180).max(180).optional(),
  neLat: z.coerce.number().min(-90).max(90).optional(),
  neLng: z.coerce.number().min(-180).max(180).optional(),
});
