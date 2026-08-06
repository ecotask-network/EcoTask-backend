import { Router } from 'express';
import { getPlatformAnalytics, getTrends } from '../controllers/analyticsController.js';

const router = Router();

router.get('/platform', getPlatformAnalytics);
router.get('/trends', getTrends);

export default router;
