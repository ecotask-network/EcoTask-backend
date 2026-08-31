import { createHash } from 'crypto';
import prisma from '../utils/prisma.js';
import config from '../config/default.js';
import logger from '../utils/logger.js';

export interface DispatchResult {
  channel: string;
  delivered: boolean;
  error?: string;
}

/**
 * Derives a stable idempotency key for a single logical webhook delivery.
 *
 * The key is a SHA-256 hex digest of `${outboxId}:${webhookUrl}`, which
 * guarantees two properties:
 *
 *   1. **Retry-stable**: BullMQ retries of the same job (same outboxId,
 *      same URL) always produce the identical key, so consumers can detect
 *      and discard duplicates.
 *
 *   2. **Subscriber-unique**: if the same outbox row were ever fanned out
 *      to two different webhook URLs (not currently the case — each User
 *      has at most one webhookUrl), each subscriber receives a distinct key.
 *
 * NOTE — deliberate re-sends after permanent failure: the current schema
 * has no "delivery generation" column on NotificationOutbox (no resetAt,
 * redeliveryCount, etc.). A row that reaches DEAD_LETTER stays there; there
 * is no operator-facing "reset and re-deliver" path yet. If such a flow is
 * added in the future, a generation counter MUST be incorporated into this
 * key (e.g. `${outboxId}:${webhookUrl}:${generation}`) so that a genuine
 * re-send produces a new key and consumers do not suppress it. Track this
 * as a follow-up: add a `deliveryGeneration Int @default(0)` column to
 * NotificationOutbox and thread it through here.
 *
 * Consumer expectation: a webhook consumer that receives a POST with an
 * Idempotency-Key it has already successfully processed SHOULD treat the
 * repeat request as a no-op and return the original result without
 * reprocessing. This repo cannot enforce that behaviour server-side — it
 * is a documented contract for consumer implementations.
 */
export function buildWebhookIdempotencyKey(outboxId: string, webhookUrl: string): string {
  return createHash('sha256').update(`${outboxId}:${webhookUrl}`).digest('hex');
}

async function sendWebhook(
  outboxId: string,
  url: string,
  payload: Record<string, unknown>,
): Promise<DispatchResult> {
  const idempotencyKey = buildWebhookIdempotencyKey(outboxId, url);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.notification.webhookTimeoutMs,
  );
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
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
  outboxId?: string,
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
    // Use outboxId for the idempotency key when available (normal dispatch
    // path). Fall back to notificationId so direct calls (e.g. tests, admin
    // retrigger) still produce a stable, non-random key.
    const keyBase = outboxId ?? notificationId;
    results.push(await sendWebhook(keyBase, user.webhookUrl, payload));
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
