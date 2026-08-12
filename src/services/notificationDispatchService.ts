import prisma from '../utils/prisma.js';
import config from '../config/default.js';
import logger from '../utils/logger.js';

export interface DispatchResult {
  channel: string;
  delivered: boolean;
  error?: string;
}

async function sendWebhook(
  url: string,
  payload: Record<string, unknown>,
): Promise<DispatchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.notification.webhookTimeoutMs,
  );
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        channel: 'webhook',
        delivered: false,
        error: `webhook returned ${res.status}`,
      };
    }
    return { channel: 'webhook', delivered: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: 'webhook', delivered: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

export function sendEmail(to: string, payload: Record<string, unknown>): DispatchResult {
  // SMTP transport is not configured yet; the outbound email is structured-logged
  // so it can be inspected locally and swapped for a real provider later.
  logger.info('Dispatching notification email (mock transport)', {
    to,
    from: config.notification.emailFrom,
    ...payload,
  });
  return { channel: 'email', delivered: true };
}

export async function dispatchNotification(
  notificationId: string,
): Promise<DispatchResult> {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    include: { user: true },
  });

  if (!notification) {
    return { channel: 'inbox', delivered: false, error: 'notification not found' };
  }

  if (notification.deliveredAt) {
    return { channel: notification.channel || 'inbox', delivered: true };
  }

  const payload = {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    createdAt: notification.createdAt.toISOString(),
  };

  const user = notification.user;
  const results: DispatchResult[] = [];

  if (user.webhookUrl) {
    results.push(await sendWebhook(user.webhookUrl, payload));
  }
  if (user.email) {
    results.push(sendEmail(user.email, payload));
  }

  // Always acknowledge the in-app inbox as a delivery target.
  results.push({ channel: 'inbox', delivered: true });

  const preferred =
    results.find((r) => r.channel === 'webhook') ||
    results.find((r) => r.channel === 'email') ||
    results[results.length - 1];

  const allDelivered = results.every((r) => r.delivered);
  const error = allDelivered
    ? null
    : results
        .filter((r) => !r.delivered)
        .map((r) => `${r.channel}: ${r.error || 'failed'}`)
        .join('; ');

  await prisma.notification.update({
    where: { id: notification.id },
    data: {
      channel: preferred.channel,
      deliveredAt: allDelivered ? new Date() : null,
      deliveryError: error,
    },
  });

  return {
    channel: preferred.channel,
    delivered: allDelivered,
    error: error || undefined,
  };
}
