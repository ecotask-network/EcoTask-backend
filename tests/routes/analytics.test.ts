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
  },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  task: { count: jest.Mock };
  user: { count: jest.Mock };
  proof: { count: jest.Mock; findMany: jest.Mock };
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
        { task: { rewardAmount: 50 } },
        { task: { rewardAmount: 30 } },
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
});
