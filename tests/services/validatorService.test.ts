import {
  assignValidators,
  listPendingReviews,
  castVote,
  resolveQuorum,
} from '../../src/services/validatorService';

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    proof: { findUnique: jest.fn(), update: jest.fn() },
    user: { findMany: jest.fn(), update: jest.fn() },
    validatorVote: {
      count: jest.fn(),
      createMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    verification: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../src/config/default', () => ({
  validator: { assignmentCount: 3, quorumRequired: 2 },
}));

jest.mock('../../src/services/notificationService', () => ({
  notifyProofStatus: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/models/task', () => ({
  completeTaskIfFull: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../src/workers/rewardWorker', () => ({
  enqueueRewardPayout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock; update: jest.Mock };
  user: { findMany: jest.Mock; update: jest.Mock };
  validatorVote: {
    count: jest.Mock;
    createMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    findMany: jest.Mock;
  };
  verification: { create: jest.Mock };
  $transaction: jest.Mock;
};

function votesProof(verdicts: (string | null)[]) {
  return {
    id: 'proof-1',
    status: 'VERIFYING',
    validatorVotes: verdicts.map((v, i) => ({
      id: `vote-${i}`,
      validatorId: `v${i}`,
      verdict: v,
    })),
  };
}

describe('ValidatorService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (ops: unknown[]) => {
      for (const op of ops as Array<Promise<unknown>>) await op;
      return [];
    });
  });

  describe('assignValidators', () => {
    it('assigns least-loaded validators excluding the proof submitter', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        userId: 'owner-1',
        status: 'VERIFYING',
      });
      mockPrisma.validatorVote.count.mockResolvedValue(0);
      mockPrisma.user.findMany.mockResolvedValue([
        { id: 'v1' },
        { id: 'v2' },
        { id: 'v3' },
      ]);
      mockPrisma.validatorVote.createMany.mockResolvedValue({ count: 3 });

      const assigned = await assignValidators('proof-1');

      expect(assigned).toBe(3);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { role: 'VALIDATOR', id: { not: 'owner-1' } },
          orderBy: { reviewCount: 'asc' },
        }),
      );
      expect(mockPrisma.validatorVote.createMany).toHaveBeenCalledWith({
        data: [
          { proofId: 'proof-1', validatorId: 'v1' },
          { proofId: 'proof-1', validatorId: 'v2' },
          { proofId: 'proof-1', validatorId: 'v3' },
        ],
      });
    });

    it('skips proofs that already have assigned votes', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        userId: 'owner-1',
        status: 'VERIFYING',
      });
      mockPrisma.validatorVote.count.mockResolvedValue(2);

      const assigned = await assignValidators('proof-1');

      expect(assigned).toBe(0);
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns 0 when no validators are available', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        userId: 'owner-1',
        status: 'VERIFYING',
      });
      mockPrisma.validatorVote.count.mockResolvedValue(0);
      mockPrisma.user.findMany.mockResolvedValue([]);

      const assigned = await assignValidators('proof-1');

      expect(assigned).toBe(0);
      expect(mockPrisma.validatorVote.createMany).not.toHaveBeenCalled();
    });

    it('returns 0 for proofs already in a final state', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        userId: 'owner-1',
        status: 'APPROVED',
      });

      const assigned = await assignValidators('proof-1');

      expect(assigned).toBe(0);
    });
  });

  describe('listPendingReviews', () => {
    it('returns only votes the validator has not decided yet', async () => {
      mockPrisma.validatorVote.findMany.mockResolvedValue([
        { id: 'vote-1', proof: { id: 'proof-1' } },
      ]);

      const reviews = await listPendingReviews('v1');

      expect(reviews).toHaveLength(1);
      expect(mockPrisma.validatorVote.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { validatorId: 'v1', verdict: null } }),
      );
    });
  });

  describe('castVote', () => {
    it('throws when the validator has no assignment for the proof', async () => {
      mockPrisma.validatorVote.findUnique.mockResolvedValue(null);

      await expect(castVote('proof-1', 'v1', 'approved')).rejects.toThrow(
        /Vote not found/,
      );
    });

    it('throws when the validator already cast a vote', async () => {
      mockPrisma.validatorVote.findUnique.mockResolvedValue({
        id: 'vote-1',
        verdict: 'approved',
        proof: { status: 'VERIFYING' },
      });

      await expect(castVote('proof-1', 'v1', 'approved')).rejects.toThrow(/already cast/);
    });

    it('finalizes the proof when a quorum agrees', async () => {
      mockPrisma.validatorVote.findUnique.mockResolvedValue({
        id: 'vote-1',
        verdict: null,
        proof: { status: 'VERIFYING' },
      });
      mockPrisma.validatorVote.update.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});

      mockPrisma.proof.findUnique.mockResolvedValueOnce(
        votesProof(['approved', 'approved', null]),
      );
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        userId: 'owner-1',
        taskId: 'task-1',
      });
      mockPrisma.verification.create.mockResolvedValue({});
      mockPrisma.proof.update.mockResolvedValue({});

      const { notifyProofStatus } = jest.requireMock(
        '../../src/services/notificationService',
      ) as {
        notifyProofStatus: jest.Mock;
      };
      const { completeTaskIfFull } = jest.requireMock('../../src/models/task') as {
        completeTaskIfFull: jest.Mock;
      };
      const { enqueueRewardPayout } = jest.requireMock(
        '../../src/workers/rewardWorker',
      ) as {
        enqueueRewardPayout: jest.Mock;
      };

      const outcome = await castVote('proof-1', 'v1', 'approved');

      expect(outcome).toEqual({ finalized: true, status: 'APPROVED' });
      expect(mockPrisma.proof.update).toHaveBeenCalledWith({
        where: { id: 'proof-1' },
        data: { status: 'APPROVED' },
      });
      expect(notifyProofStatus).toHaveBeenCalledWith('owner-1', 'proof-1', 'APPROVED');
      expect(completeTaskIfFull).toHaveBeenCalledWith('task-1');
      expect(enqueueRewardPayout).toHaveBeenCalledWith('proof-1');
    });

    it('rewards agreeing validators reputation and penalizes dissenters', async () => {
      mockPrisma.validatorVote.findUnique.mockResolvedValue({
        id: 'vote-1',
        verdict: null,
        proof: { status: 'VERIFYING' },
      });
      mockPrisma.validatorVote.update.mockResolvedValue({});
      mockPrisma.user.update.mockResolvedValue({});

      mockPrisma.proof.findUnique.mockResolvedValueOnce(
        votesProof(['approved', 'approved', 'rejected']),
      );
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        userId: 'owner-1',
        taskId: 'task-1',
      });
      mockPrisma.verification.create.mockResolvedValue({});
      mockPrisma.proof.update.mockResolvedValue({});

      await castVote('proof-1', 'v1', 'approved');

      const updateCalls = mockPrisma.user.update.mock.calls;
      expect(updateCalls).toEqual(
        expect.arrayContaining([
          [{ where: { id: 'v0' }, data: { validatorReputation: { increment: 1 } } }],
          [{ where: { id: 'v1' }, data: { validatorReputation: { increment: 1 } } }],
          [{ where: { id: 'v2' }, data: { validatorReputation: { decrement: 1 } } }],
        ]),
      );
    });
  });

  describe('resolveQuorum', () => {
    it('returns early for proofs already finalized', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: 'proof-1',
        status: 'APPROVED',
        validatorVotes: [],
      });

      const outcome = await resolveQuorum('proof-1');

      expect(outcome).toEqual({ finalized: false, status: 'APPROVED' });
      expect(mockPrisma.verification.create).not.toHaveBeenCalled();
    });

    it('waits while fewer than the quorum have voted', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue(votesProof(['approved', null, null]));

      const outcome = await resolveQuorum('proof-1');

      expect(outcome).toEqual({ finalized: false });
      expect(mockPrisma.verification.create).not.toHaveBeenCalled();
    });

    it('escalates to admin when all votes are split without a quorum', async () => {
      mockPrisma.proof.findUnique.mockResolvedValue(votesProof(['approved']));
      mockPrisma.verification.create.mockResolvedValue({});

      const outcome = await resolveQuorum('proof-1');

      expect(outcome).toEqual({ finalized: false, escalated: true });
      expect(mockPrisma.verification.create).toHaveBeenCalledWith({
        data: {
          proofId: 'proof-1',
          verifierId: 'quorum',
          verdict: 'inconclusive',
          notes: expect.stringContaining('admin review'),
        },
      });
    });

    it('finalizes as rejected when a quorum of validators rejects', async () => {
      mockPrisma.proof.findUnique.mockResolvedValueOnce(
        votesProof(['rejected', 'rejected', null]),
      );
      mockPrisma.proof.findUnique.mockResolvedValueOnce({
        userId: 'owner-1',
        taskId: 'task-1',
      });
      mockPrisma.verification.create.mockResolvedValue({});
      mockPrisma.proof.update.mockResolvedValue({});

      const outcome = await resolveQuorum('proof-1');

      expect(outcome).toEqual({ finalized: true, status: 'REJECTED' });
      expect(mockPrisma.proof.update).toHaveBeenCalledWith({
        where: { id: 'proof-1' },
        data: { status: 'REJECTED' },
      });
    });
  });
});
