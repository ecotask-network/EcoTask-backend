import { Router } from 'express';
import {
  claimTask,
  releaseClaim,
  getTaskClaims,
} from '../controllers/taskClaimController.js';
import { authMiddleware } from '../middleware/auth.js';
import { auditMiddleware } from '../middleware/audit.js';
import { claimLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.post(
  '/:id/claim',
  authMiddleware,
  claimLimiter,
  auditMiddleware('task.claim', 'task'),
  claimTask,
);
router.delete(
  '/:id/claim',
  authMiddleware,
  claimLimiter,
  auditMiddleware('task.release', 'task'),
  releaseClaim,
);
router.get('/:id/claims', authMiddleware, getTaskClaims);

export default router;
