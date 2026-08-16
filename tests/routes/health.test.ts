import request from 'supertest';
import app from '../../src/app';
import { registerWorker, unregisterWorker } from '../../src/utils/workerHealth';

describe('Health Endpoints', () => {
  describe('GET /health', () => {
    it('should return 200 when database and redis are healthy', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.service).toBe('ecotask-backend');
      expect(response.body.checks.database).toBe('ok');
      expect(response.body.checks.redis).toBe('ok');
    });
  });

  describe('GET /health/readiness', () => {
    beforeEach(() => {
      // Register workers for testing
      registerWorker('verification');
      registerWorker('reward');
      registerWorker('notification');
    });

    afterEach(() => {
      // Clean up worker registry
      unregisterWorker('verification');
      unregisterWorker('reward');
      unregisterWorker('notification');
    });

    it('should return 200 when all workers are alive and queues are healthy', async () => {
      const response = await request(app).get('/health/readiness');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('ecotask-backend');
      expect(response.body.workers.verification.alive).toBe(true);
      expect(response.body.workers.reward.alive).toBe(true);
      expect(response.body.workers.notification.alive).toBe(true);
      expect(response.body.queues).toHaveProperty('proof-verification');
      expect(response.body.queues).toHaveProperty('reward-payout');
      expect(response.body.queues).toHaveProperty('notification-dispatch');
    });

    it('should return 503 when verification worker is not alive', async () => {
      unregisterWorker('verification');
      
      const response = await request(app).get('/health/readiness');
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('degraded');
      expect(response.body.workers.verification.alive).toBe(false);
    });

    it('should return 503 when reward worker is not alive', async () => {
      unregisterWorker('reward');
      
      const response = await request(app).get('/health/readiness');
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('degraded');
      expect(response.body.workers.reward.alive).toBe(false);
    });

    it('should return 503 when notification worker is not alive', async () => {
      unregisterWorker('notification');
      
      const response = await request(app).get('/health/readiness');
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('degraded');
      expect(response.body.workers.notification.alive).toBe(false);
    });

    it('should include queue metrics in response', async () => {
      const response = await request(app).get('/health/readiness');
      expect(response.body.queues['proof-verification']).toHaveProperty('waiting');
      expect(response.body.queues['proof-verification']).toHaveProperty('active');
      expect(response.body.queues['proof-verification']).toHaveProperty('completed');
      expect(response.body.queues['proof-verification']).toHaveProperty('failed');
      expect(response.body.queues['proof-verification']).toHaveProperty('delayed');
    });
  });
});
