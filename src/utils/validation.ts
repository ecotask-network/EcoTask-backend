import { z } from 'zod';

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

export const radiusMetersField = z
  .number()
  .positive()
  .max(100000, 'radiusMeters must not exceed 100km');

export const maxCompletionsField = z
  .number()
  .int()
  .positive()
  .max(100000, 'maxCompletions must not exceed 100000');

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.string().min(1).max(50),
  rewardAmount: z.number().positive(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusMeters: radiusMetersField.optional(),
  maxCompletions: maxCompletionsField.optional(),
  expiresAt: z.string().datetime().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  type: z.string().min(1).max(50).optional(),
  rewardAmount: z.number().positive().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radiusMeters: radiusMetersField.optional(),
  maxCompletions: maxCompletionsField.optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'EXPIRED']).optional(),
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
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(20).optional(),
});

export const submitProofSchema = z.object({
  taskId: z.string().uuid(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  notes: z.string().max(1000).optional(),
});

export const listProofsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(20),
});

export const listPendingProofsQuerySchema = z.object({
  status: z.enum(['PENDING', 'VERIFYING']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(20),
});

export const reviewProofSchema = z.object({
  verdict: z.enum(['approved', 'rejected']),
  notes: z.string().max(1000).optional(),
});

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).default(20),
});

export const updateNotificationPrefsSchema = z.object({
  email: z.string().email().max(254).optional(),
  webhookUrl: z.string().url().max(2048).optional(),
});

export const MAX_PAGINATION_LIMIT = 100;
