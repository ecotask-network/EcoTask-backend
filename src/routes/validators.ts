import { Router } from 'express';
import * as validatorController from '../controllers/validatorController.js';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { validatorMiddleware } from '../middleware/validator.js';
import { auditMiddleware } from '../middleware/audit.js';

const router = Router();

router.get(
  '/validators',
  authMiddleware,
  adminMiddleware,
  validatorController.listValidators,
);
router.post(
  '/validators/:userId/activate',
  authMiddleware,
  adminMiddleware,
  auditMiddleware('validator.activate', 'user'),
  validatorController.activateValidator,
);
router.post(
  '/validators/:userId/deactivate',
  authMiddleware,
  adminMiddleware,
  auditMiddleware('validator.deactivate', 'user'),
  validatorController.deactivateValidator,
);

router.get(
  '/validator/reviews',
  authMiddleware,
  validatorMiddleware,
  validatorController.getMyReviews,
);
router.post(
  '/validator/reviews/:proofId',
  authMiddleware,
  validatorMiddleware,
  auditMiddleware('validator.review', 'proof'),
  validatorController.submitReview,
);

export default router;
