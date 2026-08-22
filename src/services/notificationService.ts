import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '../utils/prisma.js';
import logger from '../utils/logger.js';
import { getRequestId } from '../utils/requestContext.js';
import { ProofStatus } from '@prisma/client';

export interface NotificationInput {
  userId: string;
  type: string;
  title: string;
  body?: string;
}

export interface CreatedNotification {
  notificationId: string;
  outboxId: string;
}

// Any caller already inside a `prisma.$transaction(async (tx) => ...)` should
// pass that `tx` client so the notification + outbox row are persisted
// atomically with whatever event triggered them (e.g. a proof status
// change). Callers not already in a transaction can omit it and fall back to
// the top-level client.
type PrismaOrTx = PrismaClient | Prisma.TransactionClient;

/**
 * Persists a notification together with an outbox row in the same call, so
 * the write either commits both records or neither. The outbox row is what
 * makes delivery recoverable: enqueueing to BullMQ happens later, out of
 * band, via `drainNotificationOutbox` — so a crash right after this function
 * returns (but before anything gets enqueued) still leaves a PENDING outbox
 * row that a later drain sweep will pick up and deliver.
 *
 * Errors are intentionally NOT caught here. If the caller passed a `tx`, an
 * error must propagate so the surrounding transaction rolls back instead of
 * silently losing the notification.
 */
export async function createNotification(
  input: NotificationInput,
  txOrRequestId: PrismaOrTx | string = prisma,
  requestId?: string,
): Promise<CreatedNotification> {
  const tx = typeof txOrRequestId === 'string' ? prisma : txOrRequestId;
  const resolvedRequestId =
    typeof txOrRequestId === 'string' ? txOrRequestId : (requestId ?? getRequestId());
  const notification = await tx.notification.create({ data: input });
  const outbox = await tx.notificationOutbox.create({
    data: {
      notificationId: notification.id,
      ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
    },
  });
  logger.info('Notification and outbox row persisted', {
    notificationId: notification.id,
    outboxId: outbox.id,
    ...input,
    ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
  });
  return { notificationId: notification.id, outboxId: outbox.id };
}

export async function notifyProofStatus(
  userId: string,
  proofId: string,
  status: ProofStatus,
  txOrRequestId: PrismaOrTx | string = prisma,
  requestId?: string,
): Promise<CreatedNotification> {
  const tx = typeof txOrRequestId === 'string' ? prisma : txOrRequestId;
  const resolvedRequestId =
    typeof txOrRequestId === 'string' ? txOrRequestId : (requestId ?? getRequestId());
  const isApproved = status === ProofStatus.APPROVED;
  const created = await createNotification(
    {
      userId,
      type: isApproved ? 'proof.approved' : 'proof.rejected',
      title: isApproved ? 'Proof approved' : 'Proof rejected',
      body: isApproved
        ? 'Your proof was approved and your reward is on its way to your wallet.'
        : 'Your proof was rejected. Please review the notes and submit a new proof.',
    },
    tx,
    resolvedRequestId,
  );
  logger.info('Sending proof status notification', {
    userId,
    proofId,
    status,
    ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
  });
  return created;
}
