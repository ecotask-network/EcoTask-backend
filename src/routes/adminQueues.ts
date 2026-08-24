import { Router } from 'express';
import {
  getFailedJobs,
  getQueueOverview,
  retryJob,
} from '../controllers/queueAdminController.js';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';

const router = Router();

router.get('/queues', authMiddleware, adminMiddleware, getQueueOverview);
router.get('/queues/:queueName/failed', authMiddleware, adminMiddleware, getFailedJobs);
router.post(
  '/queues/:queueName/jobs/:jobId/retry',
  authMiddleware,
  adminMiddleware,
  retryJob,
);

export default router;
