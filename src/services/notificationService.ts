import prisma from '../utils/prisma.js';
import logger from '../utils/logger.js';
import { enqueueNotificationDispatch } from '../workers/notificationWorker.js';

export interface NotificationInput {
  userId: string;
  type: string;
  title: string;
  body?: string;
}

export async function createNotification(
  input: NotificationInput,
  requestId?: string,
): Promise<void> {
  try {
    const notification = await prisma.notification.create({ data: input });
    await enqueueNotificationDispatch(notification.id, requestId);
  } catch (err) {
    logger.error('Failed to persist notification', {
      err,
      ...input,
      ...(requestId ? { requestId } : {}),
    });
  }
}

export async function notifyProofStatus(
  userId: string,
  proofId: string,
  status: string,
  requestId?: string,
): Promise<void> {
  const isApproved = status === 'APPROVED';
  await createNotification(
    {
      userId,
      type: isApproved ? 'proof.approved' : 'proof.rejected',
      title: isApproved ? 'Proof approved' : 'Proof rejected',
      body: isApproved
        ? 'Your proof was approved and your reward is on its way to your wallet.'
        : 'Your proof was rejected. Please review the notes and submit a new proof.',
    },
    requestId,
  );
  logger.info('Sending proof status notification', {
    userId,
    proofId,
    status,
    ...(requestId ? { requestId } : {}),
  });
}
