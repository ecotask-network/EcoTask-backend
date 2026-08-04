import { Router } from 'express';
import {
  claimTask,
  releaseClaim,
  getTaskClaims,
} from '../controllers/taskClaimController.js';
import { authMiddleware } from '../middleware/auth.js';
import { auditMiddleware } from '../middleware/audit.js';

const router = Router();

router.post(
  '/:id/claim',
  authMiddleware,
  auditMiddleware('task.claim', 'task'),
  claimTask,
);
router.delete(
  '/:id/claim',
  authMiddleware,
  auditMiddleware('task.release', 'task'),
  releaseClaim,
);
router.get('/:id/claims', authMiddleware, getTaskClaims);

export default router;
