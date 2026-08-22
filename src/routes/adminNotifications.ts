import { Router } from 'express';
import { getDeadLetteredNotifications } from '../controllers/notificationOutboxController.js';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';

const router = Router();

router.get(
  '/notifications/dead-letter',
  authMiddleware,
  adminMiddleware,
  getDeadLetteredNotifications,
);

export default router;
