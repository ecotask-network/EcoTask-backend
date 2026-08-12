/// <reference path="./types/express.d.ts" />

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import taskRoutes from './routes/tasks.js';
import taskClaimRoutes from './routes/taskClaims.js';
import proofRoutes from './routes/proofs.js';
import healthRoutes from './routes/health.js';
import leaderboardRoutes from './routes/leaderboard.js';
import analyticsRoutes from './routes/analytics.js';
import auditRoutes from './routes/audit.js';
import notificationRoutes from './routes/notifications.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiLimiter, authLimiter, proofLimiter } from './middleware/rateLimit.js';
import { sanitizeInput } from './middleware/sanitize.js';
import prisma from './utils/prisma.js';
import logger from './utils/logger.js';
import { validateEnv } from './config/validate.js';
import config from './config/default.js';

if (process.env.NODE_ENV !== 'test') {
  validateEnv();
}

if (process.env.NODE_ENV !== 'test') {
  import('./workers/verificationWorker.js');
  import('./workers/rewardWorker.js').then(({ startRewardWorker }) => {
    startRewardWorker();
  });
  import('./workers/expiryWorker.js').then(({ startExpirySweeper }) => {
    startExpirySweeper();
  });
  import('./workers/notificationWorker.js').then(({ startNotificationWorker }) => {
    startNotificationWorker();
  });
}

const app = express();

app.use(helmet());
app.use(
  cors({
    origin:
      config.corsOrigin === '*' ? '*' : config.corsOrigin.split(',').map((o) => o.trim()),
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(sanitizeInput);

app.use('/api', apiLimiter);

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'ecotask-backend' });
});

app.use('/health', healthRoutes);
app.use('/auth', authLimiter, authRoutes);
app.use('/users', userRoutes);
app.use('/tasks', taskRoutes);
app.use('/tasks', taskClaimRoutes);
app.use('/proofs', proofLimiter, proofRoutes);
app.use('/leaderboard', leaderboardRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/audit', auditRoutes);
app.use('/notifications', notificationRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    logger.info(`EcoTask backend running on http://localhost:${PORT}`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, starting graceful shutdown`);
    server.close(async () => {
      logger.info('HTTP server closed');

      const [{ shutdownVerificationWorker }, { shutdownRewardWorker }] =
        await Promise.all([
          import('./workers/verificationWorker.js'),
          import('./workers/rewardWorker.js'),
        ]);
      await Promise.all([shutdownVerificationWorker(), shutdownRewardWorker()]);
      logger.info('Background workers shut down');

      const { shutdownNotificationWorker } =
        await import('./workers/notificationWorker.js');
      await shutdownNotificationWorker();
      logger.info('Notification dispatch worker shut down');

      const { stopExpirySweeper } = await import('./workers/expiryWorker.js');
      stopExpirySweeper();
      logger.info('Expiry sweeper stopped');

      await prisma.$disconnect();
      logger.info('Prisma client disconnected');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export default app;
