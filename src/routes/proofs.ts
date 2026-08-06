import { Router } from 'express';
import * as proofController from '../controllers/proofController.js';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { auditMiddleware } from '../middleware/audit.js';
import { upload } from '../middleware/upload.js';

const router = Router();

router.post(
  '/',
  authMiddleware,
  auditMiddleware('proof.submit', 'proof'),
  upload.array('photos', 5),
  proofController.submitProof,
);
router.get('/review', authMiddleware, adminMiddleware, proofController.listPendingProofs);
router.post(
  '/:id/review',
  authMiddleware,
  adminMiddleware,
  auditMiddleware('proof.review', 'proof'),
  proofController.reviewProof,
);
router.get('/:id', authMiddleware, proofController.getProof);
router.get('/user/:userId', authMiddleware, proofController.getUserProofs);

export default router;
