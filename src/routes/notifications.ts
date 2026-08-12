import { Router } from 'express';
import * as notificationController from '../controllers/notificationController.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

router.use(authMiddleware);
router.get('/', notificationController.listNotifications);
router.get('/unread-count', notificationController.getUnreadCount);
router.post('/preferences', notificationController.updateNotificationPrefs);
router.post('/read-all', notificationController.markAllRead);
router.post('/:id/read', notificationController.markNotificationRead);

export default router;
