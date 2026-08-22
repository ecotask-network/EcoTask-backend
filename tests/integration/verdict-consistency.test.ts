/**
 * Integration test for issue: capacity-rejected proofs have contradictory
 * Verification.verdict vs Proof.status.
 *
 * Acceptance criteria (from issue):
 *   A Verification row's effectiveVerdict always matches the resulting
 *   Proof.status (lower-case) across all three finalizers:
 *     1. verificationWorker (auto-verifier approved path)
 *     2. proofController.reviewProof (human admin review)
 *     3. validatorService.finalizeProof (quorum vote)
 *
 * These tests run against the real application logic with mocked I/O
 * (prisma, redis, bullmq) — no database required. They are co-located
 * under tests/integration/ because they exercise multiple modules
 * interacting together, not a single unit.
 */

// ─── shared mock infrastructure ──────────────────────────────────────────────

jest.mock('bullmq', () => ({
  Worker: jest.fn(() => ({ on: jest.fn(), close: jest.fn().mockResolvedValue(undefined) })),
  Queue: jest.fn(() => ({
    add: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('ioredis', () => {
  class MockRedis {
    on() {
      return this;
    }
    quit() {
      return Promise.resolve();
    }
  }
  return { __esModule: true, default: MockRedis };
});

jest.mock('../../src/config/default', () => ({
  redis: { url: 'redis://localhost:6379' },
  validator: { assignmentCount: 3, quorumRequired: 2 },
}));

jest.mock('../../src/services/verificationService', () => ({
  autoVerify: jest.fn(),
}));

jest.mock('../../src/services/notificationService', () => ({
  notifyProofStatus: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/validatorService', () => ({
  assignValidators: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// ─── prisma mock ─────────────────────────────────────────────────────────────

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    proof: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    verification: { create: jest.fn() },
    rewardPayout: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../src/models/task', () => ({
  claimCompletionSlot: jest.fn(),
}));

// ─── imports (after mocks) ────────────────────────────────────────────────────

import { Worker } from 'bullmq';
import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
  verification: { create: jest.Mock };
  rewardPayout: { create: jest.Mock };
  $transaction: jest.Mock;
};

// The verification worker registers its processor in module scope.
const workerProcessor = (Worker as unknown as jest.Mock).mock.calls[0][1] as (job: {
  id: string;
  data: { proofId: string; requestId?: string };
}) => Promise<void>;

// ─── helpers ─────────────────────────────────────────────────────────────────

function mockSlotFull() {
  const { claimCompletionSlot } = jest.requireMock('../../src/models/task') as {
    claimCompletionSlot: jest.Mock;
  };
  claimCompletionSlot.mockResolvedValue({ claimed: false, taskCompleted: false });
  return claimCompletionSlot;
}

function mockSlotOpen() {
  const { claimCompletionSlot } = jest.requireMock('../../src/models/task') as {
    claimCompletionSlot: jest.Mock;
  };
  claimCompletionSlot.mockResolvedValue({ claimed: true, taskCompleted: false });
  return claimCompletionSlot;
}

function capturedVerification(): { verdict: string; effectiveVerdict: string } {
  const call = mockPrisma.verification.create.mock.calls[0][0];
  return call.data as { verdict: string; effectiveVerdict: string };
}

// ─── suites ──────────────────────────────────────────────────────────────────

describe('Verdict ↔ Proof.status consistency (issue: capacity-rejected contradiction)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
    );
    mockPrisma.proof.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.proof.update.mockResolvedValue({});
    mockPrisma.rewardPayout.create.mockResolvedValue({});
    mockPrisma.verification.create.mockResolvedValue({});
  });

  // ── Finalizer 1: verificationWorker ────────────────────────────────────────

  describe('Finalizer 1 – verificationWorker (auto-verifier)', () => {
    beforeEach(() => {
      mockPrisma.proof.findUnique
        // First call: updateMany guard check (skipping) — not reached on count=1
        .mockResolvedValueOnce({ userId: 'user-1', taskId: 'task-1' });
    });

    it('sets effectiveVerdict = "rejected" when slot is full despite approved autoVerify result', async () => {
      const { autoVerify } = jest.requireMock('../../src/services/verificationService') as {
        autoVerify: jest.Mock;
      };
      autoVerify.mockResolvedValue({ verdict: 'approved', confidence: 0.95, notes: 'ok' });
      mockSlotFull();

      await workerProcessor({ id: 'job-1', data: { proofId: 'proof-1' } });

      // Proof must have been rejected
      expect(mockPrisma.proof.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'REJECTED' } }),
      );

      // Verification.verdict preserves AI intent; effectiveVerdict matches outcome
      const v = capturedVerification();
      expect(v.verdict).toBe('approved');
      expect(v.effectiveVerdict).toBe('rejected');
    });

    it('effectiveVerdict = "approved" when slot is available (happy path)', async () => {
      const { autoVerify } = jest.requireMock('../../src/services/verificationService') as {
        autoVerify: jest.Mock;
      };
      autoVerify.mockResolvedValue({ verdict: 'approved', confidence: 0.95, notes: 'ok' });
      mockSlotOpen();

      await workerProcessor({ id: 'job-2', data: { proofId: 'proof-2' } });

      expect(mockPrisma.proof.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'APPROVED' } }),
      );
      const v = capturedVerification();
      expect(v.verdict).toBe('approved');
      expect(v.effectiveVerdict).toBe('approved');
    });

    it('effectiveVerdict = "rejected" when autoVerify itself rejects', async () => {
      const { autoVerify } = jest.requireMock('../../src/services/verificationService') as {
        autoVerify: jest.Mock;
      };
      autoVerify.mockResolvedValue({ verdict: 'rejected', confidence: 0.1, notes: 'bad gps' });

      await workerProcessor({ id: 'job-3', data: { proofId: 'proof-3' } });

      expect(mockPrisma.proof.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'REJECTED' } }),
      );
      const v = capturedVerification();
      expect(v.verdict).toBe('rejected');
      expect(v.effectiveVerdict).toBe('rejected');
    });
  });

  // ── Finalizer 2: proofController.reviewProof ────────────────────────────────

  describe('Finalizer 2 – proofController.reviewProof (human admin)', () => {
    // We exercise reviewProof by importing the controller and fabricating the
    // minimal req/res/next objects it requires. This avoids standing up an
    // HTTP server while still exercising the real transaction logic.
    let reviewProof: (req: unknown, res: unknown, next: unknown) => Promise<unknown>;

    beforeAll(async () => {
      // Dynamic import after all mocks are set.
      const mod = await import('../../src/controllers/proofController');
      reviewProof = mod.reviewProof as typeof reviewProof;
    });

    function makeReqRes(verdict: 'approved' | 'rejected', notes?: string) {
      const json = jest.fn().mockReturnThis();
      const status = jest.fn().mockReturnValue({ json });
      const res = { status, json } as unknown;
      const req = {
        params: { id: 'proof-ctrl-1' },
        body: { verdict, notes },
        user: { userId: 'admin-1' },
        requestId: 'req-ctrl-1',
      } as unknown;
      return { req, res, json, status };
    }

    beforeEach(() => {
      mockPrisma.proof.findUnique.mockResolvedValue({
        id: 'proof-ctrl-1',
        userId: 'user-2',
        taskId: 'task-ctrl-1',
        status: 'PENDING',
        photos: [],
        verifications: [],
      });
    });

    it('effectiveVerdict = "rejected" when slot full despite human "approved" verdict', async () => {
      mockSlotFull();
      const { req, res } = makeReqRes('approved', 'looks good');
      await reviewProof(req, res, jest.fn());

      const v = capturedVerification();
      expect(v.verdict).toBe('approved');
      expect(v.effectiveVerdict).toBe('rejected');

      // Proof must have been rejected
      expect(mockPrisma.proof.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'REJECTED' } }),
      );
    });

    it('effectiveVerdict = "approved" when slot available and human says approved', async () => {
      mockSlotOpen();
      const { req, res } = makeReqRes('approved', 'looks good');
      await reviewProof(req, res, jest.fn());

      const v = capturedVerification();
      expect(v.verdict).toBe('approved');
      expect(v.effectiveVerdict).toBe('approved');
    });

    it('effectiveVerdict = "rejected" when human explicitly rejects (no slot check)', async () => {
      const { req, res } = makeReqRes('rejected', 'bad photo');
      await reviewProof(req, res, jest.fn());

      const v = capturedVerification();
      expect(v.verdict).toBe('rejected');
      expect(v.effectiveVerdict).toBe('rejected');
    });
  });

  // ── Finalizer 3: validatorService.finalizeProof (via resolveQuorum) ─────────

  describe('Finalizer 3 – validatorService.finalizeProof (quorum vote)', () => {
    let resolveQuorum: (proofId: string, requestId?: string) => Promise<unknown>;

    beforeAll(async () => {
      const mod = await import('../../src/services/validatorService');
      resolveQuorum = mod.resolveQuorum as typeof resolveQuorum;
    });

    function proofWithVotes(verdicts: string[]) {
      return {
        id: 'proof-q-1',
        status: 'VERIFYING',
        taskId: 'task-q-1',
        validatorVotes: verdicts.map((v, i) => ({
          id: `vote-${i}`,
          validatorId: `v${i}`,
          verdict: v,
        })),
      };
    }

    beforeEach(() => {
      // user.update is called for reputation changes — add it to mock
      (mockPrisma as unknown as { user: { update: jest.Mock } }).user = {
        update: jest.fn().mockResolvedValue({}),
      };
    });

    it('effectiveVerdict = "rejected" when quorum-approved but slot is full', async () => {
      mockPrisma.proof.findUnique
        .mockResolvedValueOnce(proofWithVotes(['approved', 'approved', null])) // resolveQuorum fetch
        .mockResolvedValueOnce({ taskId: 'task-q-1', status: 'VERIFYING' }) // finalizeProof tx fetch
        .mockResolvedValueOnce({ userId: 'user-q-1', taskId: 'task-q-1' }); // notification lookup
      mockSlotFull();

      const outcome = await resolveQuorum('proof-q-1', 'req-q-1');

      expect(outcome).toMatchObject({ finalized: true, status: 'REJECTED' });

      const v = capturedVerification();
      expect(v.verdict).toBe('approved');
      expect(v.effectiveVerdict).toBe('rejected');

      expect(mockPrisma.proof.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'REJECTED' } }),
      );
    });

    it('effectiveVerdict = "approved" when quorum-approved and slot is open', async () => {
      mockPrisma.proof.findUnique
        .mockResolvedValueOnce(proofWithVotes(['approved', 'approved', null]))
        .mockResolvedValueOnce({ taskId: 'task-q-1', status: 'VERIFYING' })
        .mockResolvedValueOnce({ userId: 'user-q-1', taskId: 'task-q-1' });
      mockSlotOpen();

      const outcome = await resolveQuorum('proof-q-1');

      expect(outcome).toMatchObject({ finalized: true, status: 'APPROVED' });
      const v = capturedVerification();
      expect(v.verdict).toBe('approved');
      expect(v.effectiveVerdict).toBe('approved');
    });

    it('effectiveVerdict = "rejected" when quorum rejects (no slot check needed)', async () => {
      mockPrisma.proof.findUnique
        .mockResolvedValueOnce(proofWithVotes(['rejected', 'rejected', null]))
        .mockResolvedValueOnce({ taskId: 'task-q-1', status: 'VERIFYING' })
        .mockResolvedValueOnce({ userId: 'user-q-1', taskId: 'task-q-1' });

      const outcome = await resolveQuorum('proof-q-1');

      expect(outcome).toMatchObject({ finalized: true, status: 'REJECTED' });
      const v = capturedVerification();
      expect(v.verdict).toBe('rejected');
      expect(v.effectiveVerdict).toBe('rejected');
    });
  });
});
