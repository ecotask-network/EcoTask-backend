import type { JobsOptions } from 'bullmq';
import config from '../config/default.js';

export const QUEUE_NAMES = {
  proofVerification: 'proof-verification',
  rewardPayout: 'reward-payout',
  notificationDispatch: 'notification-dispatch',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface QueueRetentionPolicy {
  completedCount: number;
  failedAgeSeconds: number;
}

export const DEFAULT_QUEUE_RETENTION_POLICY: QueueRetentionPolicy = {
  completedCount: 1000,
  failedAgeSeconds: 7 * 24 * 60 * 60,
};

function configuredPolicy(queueName: QueueName): QueueRetentionPolicy | undefined {
  if (queueName === QUEUE_NAMES.proofVerification) {
    return config.queueRetention?.proofVerification;
  }
  if (queueName === QUEUE_NAMES.rewardPayout) {
    return config.queueRetention?.rewardPayout;
  }
  return config.queueRetention?.notificationDispatch;
}

export function getQueueRetentionPolicy(queueName: QueueName): QueueRetentionPolicy {
  return configuredPolicy(queueName) ?? DEFAULT_QUEUE_RETENTION_POLICY;
}

export function getQueueRetentionOptions(
  queueName: QueueName,
): Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> {
  const policy = getQueueRetentionPolicy(queueName);

  return {
    removeOnComplete: { count: policy.completedCount },
    removeOnFail: { age: policy.failedAgeSeconds },
  };
}
