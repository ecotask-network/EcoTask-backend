import { Router } from 'express';
import * as userController from '../controllers/userController.js';
import { authMiddleware } from '../middleware/auth.js';
import { auditMiddleware } from '../middleware/audit.js';

const router = Router();

router.get('/me', authMiddleware, userController.getMe);
router.get('/:id', authMiddleware, userController.getUser);
router.put(
  '/:id',
  authMiddleware,
  auditMiddleware('user.update', 'user'),
  userController.updateUserProfile,
);
router.get('/:id/impact', authMiddleware, userController.getImpact);

export default router;
