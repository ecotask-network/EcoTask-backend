import { getUserImpact } from '../../src/models/user';
import prisma from '../../src/utils/prisma';

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
  },
}));

const mockPrisma = prisma as unknown as {
  $queryRaw: jest.Mock;
};

describe('getUserImpact', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return correct aggregation for user with multiple approved proofs', async () => {
    // Mock data: user has 5 approved proofs across 2 task types
    const mockAggResult = [
      { task_type: 'cleanup', proof_count: 3n, total_reward_micros: 900000000n },
      { task_type: 'recycling', proof_count: 2n, total_reward_micros: 600000000n },
    ];

    mockPrisma.$queryRaw.mockResolvedValueOnce(mockAggResult);

    const result = await getUserImpact('user-123');

    expect(result).toEqual({
      totalApproved: 5,
      totalReward: '150',
      byType: {
        cleanup: { count: 3, reward: '90' },
        recycling: { count: 2, reward: '60' },
      },
    });
  });

  it('should handle null reward amounts (unknown types)', async () => {
    const mockAggResult = [
      { task_type: 'cleanup', proof_count: 1n, total_reward_micros: 500000000n },
      { task_type: 'unknown_type', proof_count: 1n, total_reward_micros: null },
    ];

    mockPrisma.$queryRaw.mockResolvedValueOnce(mockAggResult);

    const result = await getUserImpact('user-456');

    expect(result).toEqual({
      totalApproved: 2,
      totalReward: '50',
      byType: {
        cleanup: { count: 1, reward: '50' },
        unknown_type: { count: 1, reward: '0' },
      },
    });
  });

  it('should return zeros for user with no approved proofs', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);

    const result = await getUserImpact('user-789');

    expect(result).toEqual({
      totalApproved: 0,
      totalReward: '0',
      byType: {},
    });
  });

  it('preserves precision for reward totals above the safe integer range', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { task_type: 'cleanup', proof_count: 1n, total_reward_micros: 9007199254740993n },
    ]);

    const result = await getUserImpact('whale');

    expect(result.totalReward).toBe('900719925.4740993');
    expect(result.byType.cleanup.reward).toBe('900719925.4740993');
  });

  it('should execute single indexed SQL aggregation query', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { task_type: 'cleanup', proof_count: 1n, total_reward_micros: 500000000n },
    ]);

    await getUserImpact('user-123');

    // Verify that $queryRaw was called exactly once (single query)
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);

    // Verify the query call includes the SQL template
    const queryCall = mockPrisma.$queryRaw.mock.calls[0];
    expect(queryCall).toBeDefined();
    // Template literal queries are arrays with strings and substitutions
    const queryString = queryCall[0].join('');
    expect(queryString).toContain('user_id');
    expect(queryString).toContain("status = 'APPROVED'");
    expect(queryString).toContain('GROUP BY t.type');
  });
});
