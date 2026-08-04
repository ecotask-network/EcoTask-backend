import logger from '../utils/logger.js';

export async function notifyProofStatus(
  userId: string,
  proofId: string,
  status: string,
): Promise<void> {
  logger.info('Sending proof status notification', { userId, proofId, status });
}
