import { Request, Response } from 'express';
import prisma from '../utils/prisma.js';
import {
  listNotificationsQuerySchema,
  MAX_PAGINATION_LIMIT,
} from '../utils/validation.js';

export async function listNotifications(req: Request, res: Response) {
  const parsed = listNotificationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid query parameters', details: parsed.error.flatten() });
  }

  const userId = req.user!.userId;
  const page = parsed.data.page;
  const limit = Math.min(parsed.data.limit, MAX_PAGINATION_LIMIT);
  const skip = (page - 1) * limit;

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where: { userId } }),
  ]);

  return res.json({
    data: notifications,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function getUnreadCount(req: Request, res: Response) {
  const userId = req.user!.userId;
  const count = await prisma.notification.count({ where: { userId, readAt: null } });
  return res.json({ count });
}

export async function markNotificationRead(req: Request, res: Response) {
  const userId = req.user!.userId;
  const notification = await prisma.notification.findUnique({
    where: { id: req.params.id },
  });
  if (!notification || notification.userId !== userId) {
    return res.status(404).json({ error: 'notification not found' });
  }

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { readAt: notification.readAt ?? new Date() },
  });
  return res.json(updated);
}

export async function markAllRead(req: Request, res: Response) {
  const userId = req.user!.userId;
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.json({ updated: result.count });
}
