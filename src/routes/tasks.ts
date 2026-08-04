import { Router } from 'express';
import * as taskController from '../controllers/taskController.js';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { auditMiddleware } from '../middleware/audit.js';

const router = Router();

router.get('/', taskController.listTasks);
router.get('/:id', taskController.getTask);
router.post(
  '/',
  authMiddleware,
  adminMiddleware,
  auditMiddleware('task.create', 'task'),
  taskController.createTask,
);
router.put(
  '/:id',
  authMiddleware,
  adminMiddleware,
  auditMiddleware('task.update', 'task'),
  taskController.updateTask,
);
router.delete(
  '/:id',
  authMiddleware,
  adminMiddleware,
  auditMiddleware('task.delete', 'task'),
  taskController.deleteTask,
);

export default router;
