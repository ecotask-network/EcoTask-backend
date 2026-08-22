import { Router } from 'express';
import * as authController from '../controllers/authController.js';
import { authMiddleware } from '../middleware/auth.js';
import { challengeIssueLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.get('/challenge', challengeIssueLimiter, authController.getChallenge);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.post('/verify', authMiddleware, authController.verify);

export default router;
