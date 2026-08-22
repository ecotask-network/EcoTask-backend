import request from 'supertest';
import app from '../../src/app';

jest.mock('../../src/workers/verificationWorker', () => ({
  enqueueVerification: jest.fn(),
}));

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    task: { count: jest.fn() },
    user: { count: jest.fn() },
    proof: { count: jest.fn(), findMany: jest.fn() },
    $queryRaw: jest.fn(),
  },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  task: { count: jest.Mock };
  user: { count: jest.Mock };
  proof: { count: jest.Mock; findMany: jest.Mock };
  $queryRaw: jest.Mock;
};

describe('Analytics Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /analytics/platform', () => {
    it('returns aggregated platform statistics', async () => {
      mockPrisma.task.count.mockResolvedValueOnce(10);
      mockPrisma.task.count.mockResolvedValueOnce(6);
      mockPrisma.user.count.mockResolvedValue(25);
      mockPrisma.proof.count.mockResolvedValue(100);
      mockPrisma.proof.findMany.mockResolvedValue([
        { task: { rewardAmountMicros: 500000000n } },
        { task: { rewardAmountMicros: 300000000n } },
      ]);

      const res = await request(app).get('/analytics/platform');
      expect(res.status).toBe(200);
      expect(res.body.totals).toEqual({
        tasks: 10,
        activeTasks: 6,
        users: 25,
        proofs: 100,
        approvedProofs: 2,
        totalRewardPaid: 80,
      });
    });
  });

  describe('GET /analytics/trends', () => {
    it('returns a daily series of approved proofs and rewards', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { day: new Date('2026-08-01T00:00:00Z'), count: 2, reward_micros: 1000000000n },
        { day: new Date('2026-08-02T00:00:00Z'), count: 1, reward_micros: 500000000n },
      ]);

      const res = await request(app).get('/analytics/trends').query({ days: '7' });
      expect(res.status).toBe(200);
      expect(res.body.days).toBe(7);
      expect(res.body.points).toEqual([
        { day: '2026-08-01', approvedProofs: 2, totalReward: 100 },
        { day: '2026-08-02', approvedProofs: 1, totalReward: 50 },
      ]);
    });

    it('caps the requested window at 365 days', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      const res = await request(app).get('/analytics/trends').query({ days: '9999' });
      expect(res.status).toBe(200);
      expect(res.body.days).toBe(365);
    });
  });
});
