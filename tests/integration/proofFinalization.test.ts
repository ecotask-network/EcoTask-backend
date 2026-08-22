import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import prisma from '../../src/utils/prisma';
import { finalizeProofStatus } from '../../src/services/proofFinalizationService';

describe('Proof Finalization Concurrency', () => {
  beforeAll(async () => {
    // any setup
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should only allow exactly one finalization of a proof', async () => {
    const user = await prisma.user.create({
      data: { wallet: `test-wallet-${Date.now()}` },
    });

    const task = await prisma.task.create({
      data: {
        title: 'Test Task',
        type: 'test',
        rewardAmountMicros: 1000n,
        lat: 0,
        lng: 0,
        maxCompletions: 10,
        completedCount: 0,
      },
    });

    const claim = await prisma.taskClaim.create({
      data: {
        taskId: task.id,
        userId: user.id,
        status: 'active',
        expiresAt: new Date(Date.now() + 100000),
      },
    });

    const proof = await prisma.proof.create({
      data: {
        userId: user.id,
        taskId: task.id,
        claimId: claim.id,
        status: 'PENDING',
      },
    });

    // Fire all three finalization attempts in parallel
    // 1: Admin review (expects PENDING)
    const p1 = finalizeProofStatus({
      proofId: proof.id,
      verifierId: user.id,
      verdict: 'approved',
      expectedStatuses: ['PENDING'],
    });

    // 2: Worker auto-verify (expects VERIFYING, but we manually transition it first to simulate)
    await prisma.proof.update({
      where: { id: proof.id },
      data: { status: 'VERIFYING' },
    });
    
    const p2 = finalizeProofStatus({
      proofId: proof.id,
      verifierId: 'auto-verifier',
      verdict: 'approved',
      expectedStatuses: ['VERIFYING'],
    });

    // 3: Quorum resolution (expects VERIFYING)
    const p3 = finalizeProofStatus({
      proofId: proof.id,
      verifierId: 'quorum',
      verdict: 'approved',
      expectedStatuses: ['VERIFYING'],
    });

    const results = await Promise.allSettled([p1, p2, p3]);

    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBe(1);

    const updatedProof = await prisma.proof.findUnique({
      where: { id: proof.id },
      include: {
        verifications: true,
        rewardPayout: true,
      },
    });

    expect(updatedProof?.status).toBe('APPROVED');
    expect(updatedProof?.verifications.length).toBe(1);
    expect(updatedProof?.rewardPayout).not.toBeNull();
    
    // Test that the task completed count only incremented by 1
    const updatedTask = await prisma.task.findUnique({
      where: { id: task.id },
    });
    expect(updatedTask?.completedCount).toBe(1);
  });
});
