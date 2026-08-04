import { Router } from 'express';
import { getPlatformAnalytics } from '../controllers/analyticsController.js';

const router = Router();

router.get('/platform', getPlatformAnalytics);

export default router;
