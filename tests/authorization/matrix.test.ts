import request from 'supertest';
import app from '../../src/app';
import jwt from 'jsonwebtoken';
import { ROUTE_ACCESS_MATRIX, AccessLevel } from '../../src/authorization/matrix';

// ---------------------------------------------------------------------------
// Mock layer — the matrix test never touches a live database or Redis. Every
// model/service dependency is replaced so authorised requests reach their
// handlers and return a deterministic 2xx.
// ---------------------------------------------------------------------------

jest.mock('../../src/middleware/rateLimit', () => {
  const pass = (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next();
  return {
    apiLimiter: pass,
    authLimiter: pass,
    proofLimiter: pass,
    proofSubmissionLimiter: pass,
    claimLimiter: pass,
    perUserLimiter: () => pass,
  };
});

jest.mock('../../src/services/rateLimitService', () => ({
  rateLimiter: {
    getClient: () => ({ get: jest.fn().mockResolvedValue(null) }),
    check: jest.fn().mockResolvedValue({
      allowed: true,
      remaining: 100,
      retryAfterSeconds: 0,
    }),
  },
}));

jest.mock('../../src/workers/verificationWorker', () => ({
  enqueueVerification: jest.fn(),
}));

jest.mock('../../src/workers/rewardWorker', () => ({
  enqueueRewardPayout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/notificationService', () => ({
  notifyProofStatus: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/auditService', () => ({
  logAudit: jest.fn(),
  getAuditLogs: jest.fn(),
}));

jest.mock('../../src/services/validatorService', () => ({
  assignValidators: jest.fn(),
  listPendingReviews: jest.fn(),
  castVote: jest.fn(),
  resolveQuorum: jest.fn(),
}));

jest.mock('../../src/services/notificationOutboxService', () => ({
  listDeadLetteredNotifications: jest.fn(),
}));

jest.mock('../../src/services/stellarService', () => ({
  generateChallenge: jest.fn().mockReturnValue('matrix-mock-challenge'),
  verifyStellarSignature: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../src/models/task', () => ({
  listTasks: jest.fn(),
  getTaskById: jest.fn(),
  createTask: jest.fn(),
  updateTask: jest.fn(),
  deleteTask: jest.fn(),
  getTaskCompletionCount: jest.fn(),
  completeTaskIfFull: jest.fn(),
}));

jest.mock('ioredis', () => {
  const Redis = jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue(undefined),
  }));
  return Redis;
});

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    task: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    proof: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    proofPhoto: { create: jest.fn() },
    verification: { create: jest.fn() },
    taskClaim: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    notification: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    validatorVote: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
  };
  task: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  proof: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  proofPhoto: { create: jest.Mock };
  verification: { create: jest.Mock };
  taskClaim: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
  };
  notification: {
    findMany: jest.Mock;
    count: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  $queryRaw: jest.Mock;
  $queryRawUnsafe: jest.Mock;
  $executeRaw: jest.Mock;
  $transaction: jest.Mock;
};

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

const JWT_SECRET = 'dev-secret-change-in-production';

const USERS: Record<string, Record<string, unknown>> = {
  'user-1': {
    id: 'user-1',
    wallet: 'GUSER1USER1USER1USER1USER1USER1USER1USER1USER1USER1USER11',
    name: 'User One',
    bio: 'hello',
    avatarUrl: null,
    role: 'user',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  'u-2': {
    id: 'u-2',
    wallet: 'GU2GU2GU2GU2GU2GU2GU2GU2GU2GU2GU2GU2GU2GU2GU2GU2GU2GU2GU21',
    name: 'User Two',
    bio: null,
    avatarUrl: null,
    role: 'user',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  'validator-1': {
    id: 'validator-1',
    wallet: 'GVALIDATOR1VALIDATOR1VALIDATOR1VALIDATOR1VALIDATOR1VALID01',
    name: 'Validator One',
    bio: null,
    avatarUrl: null,
    role: 'validator',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
  'admin-1': {
    id: 'admin-1',
    wallet: 'GADMIN1ADMIN1ADMIN1ADMIN1ADMIN1ADMIN1ADMIN1ADMIN1ADMIN1ADM1',
    name: 'Admin',
    bio: null,
    avatarUrl: null,
    role: 'admin',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  },
};

function token(userId: string): string {
  return jwt.sign({ userId, wallet: 'GTOKEN...' }, JWT_SECRET, {
    algorithm: 'HS256',
    issuer: 'ecotask-backend',
    audience: 'ecotask-users',
    jwtid: 'matrix-jti',
    expiresIn: '1h',
  });
}

const IDENTITIES: Record<string, string | null> = {
  anonymous: null,
  user: token('user-1'),
  otherUser: token('u-2'),
  validator: token('validator-1'),
  admin: token('admin-1'),
  deleted: token('deleted-user'),
};

type Role = 'anonymous' | 'user' | 'otherUser' | 'validator' | 'admin' | 'deleted';
const ROLES: Role[] = ['anonymous', 'user', 'otherUser', 'validator', 'admin', 'deleted'];

const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const LOGIN_WALLET = 'G'.padEnd(56, 'B');

// ---------------------------------------------------------------------------
// Test-case shape
// ---------------------------------------------------------------------------

type ExpectMap = Partial<Record<Role, number>>;

/**
 * Sentinel meaning "request must be allowed by the authz gate" — i.e. the
 * response is neither 401 (unauthenticated) nor 403 (insufficient role).
 * Used for `public` routes where a hard-coded 2xx would be wrong because the
 * business status can legitimately vary (e.g. /health returns 503 when Redis
 * is down, which is the case in the test/CI environment).
 */
const ALLOW = -1;

interface MatrixCase {
  /** HTTP method sent to the app. */
  method: string;
  /** Matrix pattern this case enforces (must exist in ROUTE_ACCESS_MATRIX). */
  pattern: string;
  /** Concrete path used for the request. */
  path: string;
  /** Status expected for roles that are allowed (2xx). */
  allowedStatus: number;
  /** Status for insufficient-role requests (default 403). */
  deniedStatus?: number;
  /** Optional JSON body. */
  body?: Record<string, unknown>;
  /** Per-role overrides of the derived expectation. */
  overrides?: ExpectMap;
  /** Restrict which roles are exercised (default: all six). */
  rolesToTest?: Role[];
  /** Optional per-case mock configuration run before the role loop. */
  setup?: () => void;
}

function expectations(
  access: AccessLevel,
  allowedStatus: number,
  deniedStatus: number,
): ExpectMap {
  switch (access) {
    case 'public':
      return {
        anonymous: ALLOW,
        user: ALLOW,
        otherUser: ALLOW,
        validator: ALLOW,
        admin: ALLOW,
        deleted: ALLOW,
      };
    case 'authenticated':
      return {
        anonymous: 401,
        user: allowedStatus,
        otherUser: allowedStatus,
        validator: allowedStatus,
        admin: allowedStatus,
        deleted: 401,
      };
    case 'admin':
      return {
        anonymous: 401,
        user: deniedStatus,
        otherUser: deniedStatus,
        validator: deniedStatus,
        admin: allowedStatus,
        deleted: 401,
      };
    case 'validator-or-admin':
      return {
        anonymous: 401,
        user: deniedStatus,
        otherUser: deniedStatus,
        validator: allowedStatus,
        admin: allowedStatus,
        deleted: 401,
      };
    case 'owner':
      return {
        anonymous: 401,
        user: allowedStatus,
        otherUser: deniedStatus,
        validator: deniedStatus,
        admin: deniedStatus,
        deleted: 401,
      };
    case 'owner-or-admin':
      return {
        anonymous: 401,
        user: allowedStatus,
        otherUser: deniedStatus,
        validator: deniedStatus,
        admin: allowedStatus,
        deleted: 401,
      };
  }
}

const CASES: MatrixCase[] = [
  // Health
  { method: 'GET', pattern: '/', path: '/', allowedStatus: 200 },
  { method: 'GET', pattern: '/health', path: '/health', allowedStatus: 200 },

  // Auth
  {
    method: 'GET',
    pattern: '/auth/challenge',
    path: `/auth/challenge?wallet=${LOGIN_WALLET}`,
    allowedStatus: 200,
  },
  {
    method: 'POST',
    pattern: '/auth/login',
    path: '/auth/login',
    allowedStatus: 200,
    rolesToTest: ['anonymous'],
    overrides: { anonymous: 200 },
  },
  {
    method: 'POST',
    pattern: '/auth/logout',
    path: '/auth/logout',
    allowedStatus: 200,
    overrides: { anonymous: 401 },
  },
  { method: 'POST', pattern: '/auth/verify', path: '/auth/verify', allowedStatus: 200 },

  // Users
  { method: 'GET', pattern: '/users/me', path: '/users/me', allowedStatus: 200 },
  { method: 'GET', pattern: '/users/:id', path: '/users/user-1', allowedStatus: 200 },
  {
    method: 'PUT',
    pattern: '/users/:id',
    path: '/users/user-1',
    allowedStatus: 200,
    body: { name: 'New Name' },
  },
  {
    method: 'GET',
    pattern: '/users/:id/impact',
    path: '/users/user-1/impact',
    allowedStatus: 200,
  },

  // Tasks
  { method: 'GET', pattern: '/tasks', path: '/tasks', allowedStatus: 200 },
  { method: 'GET', pattern: '/tasks/:id', path: '/tasks/task-1', allowedStatus: 200 },
  {
    method: 'POST',
    pattern: '/tasks',
    path: '/tasks',
    allowedStatus: 201,
    body: { title: 'Task', type: 'cleanup', rewardAmount: 10, lat: 0, lng: 0 },
  },
  {
    method: 'PUT',
    pattern: '/tasks/:id',
    path: '/tasks/task-1',
    allowedStatus: 200,
    body: { title: 'Updated' },
  },
  { method: 'DELETE', pattern: '/tasks/:id', path: '/tasks/task-1', allowedStatus: 204 },

  // Task claims
  {
    method: 'POST',
    pattern: '/tasks/:id/claim',
    path: '/tasks/task-1/claim',
    allowedStatus: 201,
  },
  {
    method: 'DELETE',
    pattern: '/tasks/:id/claim',
    path: '/tasks/task-1/claim',
    allowedStatus: 204,
    setup: () => {
      mockPrisma.taskClaim.findUnique.mockResolvedValue({
        id: 'claim-1',
        taskId: 'task-1',
        userId: 'user-1',
        status: 'active',
        claimedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      });
    },
  },
  {
    method: 'GET',
    pattern: '/tasks/:id/claims',
    path: '/tasks/task-1/claims',
    allowedStatus: 200,
  },

  // Proofs
  {
    method: 'POST',
    pattern: '/proofs',
    path: '/proofs',
    allowedStatus: 201,
    body: { taskId: VALID_UUID },
  },
  { method: 'GET', pattern: '/proofs/review', path: '/proofs/review', allowedStatus: 200 },
  {
    method: 'POST',
    pattern: '/proofs/:id/review',
    path: '/proofs/proof-1/review',
    allowedStatus: 200,
    body: { verdict: 'approved' },
  },
  { method: 'GET', pattern: '/proofs/:id', path: '/proofs/proof-1', allowedStatus: 200 },
  {
    method: 'GET',
    pattern: '/proofs/user/:userId',
    path: '/proofs/user/user-1',
    allowedStatus: 200,
  },

  // Leaderboard / analytics
  { method: 'GET', pattern: '/leaderboard', path: '/leaderboard', allowedStatus: 200 },
  {
    method: 'GET',
    pattern: '/analytics/platform',
    path: '/analytics/platform',
    allowedStatus: 200,
  },
  {
    method: 'GET',
    pattern: '/analytics/trends',
    path: '/analytics/trends',
    allowedStatus: 200,
  },

  // Audit log
  { method: 'GET', pattern: '/audit', path: '/audit', allowedStatus: 200 },

  // Notifications
  { method: 'GET', pattern: '/notifications', path: '/notifications', allowedStatus: 200 },
  {
    method: 'GET',
    pattern: '/notifications/unread-count',
    path: '/notifications/unread-count',
    allowedStatus: 200,
  },
  {
    method: 'POST',
    pattern: '/notifications/preferences',
    path: '/notifications/preferences',
    allowedStatus: 200,
    body: { email: 'user@example.com' },
  },
  {
    method: 'POST',
    pattern: '/notifications/read-all',
    path: '/notifications/read-all',
    allowedStatus: 200,
  },
  {
    method: 'POST',
    pattern: '/notifications/:id/read',
    path: '/notifications/n-1/read',
    allowedStatus: 200,
    deniedStatus: 404,
  },

  // Admin notifications
  {
    method: 'GET',
    pattern: '/admin/notifications/dead-letter',
    path: '/admin/notifications/dead-letter',
    allowedStatus: 200,
  },

  // Validators
  { method: 'GET', pattern: '/validators', path: '/validators', allowedStatus: 200 },
  {
    method: 'POST',
    pattern: '/validators/:userId/activate',
    path: '/validators/u-2/activate',
    allowedStatus: 200,
  },
  {
    method: 'POST',
    pattern: '/validators/:userId/deactivate',
    path: '/validators/u-2/deactivate',
    allowedStatus: 200,
  },
  {
    method: 'GET',
    pattern: '/validator/reviews',
    path: '/validator/reviews',
    allowedStatus: 200,
  },
  {
    method: 'POST',
    pattern: '/validator/reviews/:proofId',
    path: '/validator/reviews/proof-1',
    allowedStatus: 200,
    body: { verdict: 'approved' },
  },
];

// ---------------------------------------------------------------------------
// Shared request executor
// ---------------------------------------------------------------------------

async function loginAsWallet(wallet: string): Promise<request.Response> {
  const challengeRes = await request(app).get('/auth/challenge').query({ wallet });
  expect(challengeRes.status).toBe(200);
  return request(app).post('/auth/login').send({
    wallet,
    challenge: challengeRes.body.challenge,
    signature: 'mock-signature-123',
  });
}

async function send(c: MatrixCase, role: Role): Promise<request.Response> {
  if (c.pattern === '/auth/login') {
    return loginAsWallet(LOGIN_WALLET);
  }

  const method = c.method.toLowerCase() as
    | 'get'
    | 'post'
    | 'put'
    | 'delete';
  const auth = IDENTITIES[role];
  const req = request(app)[method](c.path);
  if (auth) {
    req.set('Authorization', `Bearer ${auth}`);
  }
  if (c.body) {
    req.send(c.body);
  }
  return req;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();

  mockPrisma.user.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(USERS[where.id] ?? null),
  );
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.user.count.mockResolvedValue(0);
  mockPrisma.user.update.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({
        id: where.id,
        wallet: 'G...',
        name: 'Updated',
        bio: null,
        avatarUrl: null,
        role: (data.role as string) ?? 'user',
        email: 'user@example.com',
        webhookUrl: 'https://hooks.example.com',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
  );
  mockPrisma.user.create.mockImplementation(
    ({ data }: { data: { wallet: string } }) =>
      Promise.resolve({ id: 'user-1', wallet: data.wallet, role: 'user' }),
  );

  mockPrisma.task.findUnique.mockResolvedValue({
    id: 'task-1',
    title: 'Task',
    type: 'cleanup',
    status: 'ACTIVE',
    rewardAmount: 10,
    lat: 0,
    lng: 0,
    maxCompletions: null,
  });
  mockPrisma.task.findMany.mockResolvedValue([]);
  mockPrisma.task.count.mockResolvedValue(0);
  mockPrisma.task.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'task-1', ...data }),
  );
  mockPrisma.task.update.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ id: where.id, ...data }),
  );
  mockPrisma.task.delete.mockResolvedValue({ id: 'task-1' });

  mockPrisma.proof.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve({
      id: where.id,
      userId: 'user-1',
      taskId: 'task-1',
      status: 'PENDING',
      photos: [],
      verifications: [],
    }),
  );
  mockPrisma.proof.findMany.mockResolvedValue([]);
  mockPrisma.proof.count.mockResolvedValue(0);
  mockPrisma.proof.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'proof-1', ...data }),
  );
  mockPrisma.proof.update.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ id: where.id, ...data }),
  );

  mockPrisma.proofPhoto.create.mockResolvedValue({});
  mockPrisma.verification.create.mockResolvedValue({});

  mockPrisma.taskClaim.findUnique.mockResolvedValue(null);
  mockPrisma.taskClaim.findMany.mockResolvedValue([]);
  mockPrisma.taskClaim.update.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ id: where.id, ...data }),
  );
  mockPrisma.taskClaim.create.mockImplementation(
    ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'claim-1', ...data }),
  );

  mockPrisma.notification.findMany.mockResolvedValue([]);
  mockPrisma.notification.count.mockResolvedValue(0);
  mockPrisma.notification.findUnique.mockImplementation(
    ({ where }: { where: { id: string } }) =>
      Promise.resolve({
        id: where.id,
        userId: 'user-1',
        readAt: null,
        type: 'proof.approved',
        title: 'Hi',
      }),
  );
  mockPrisma.notification.update.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Promise.resolve({ id: where.id, ...data }),
  );
  mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });

  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
  mockPrisma.$executeRaw.mockResolvedValue(undefined);
  mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return arg(mockPrisma);
    }
    if (Array.isArray(arg)) {
      const ops = arg as Array<Promise<unknown>>;
      for (const op of ops) {
        await op;
      }
      return [];
    }
    return undefined;
  });

  const { getAuditLogs } = jest.requireMock(
    '../../src/services/auditService',
  ) as { getAuditLogs: jest.Mock };
  getAuditLogs.mockResolvedValue({
    data: [],
    meta: { total: 0, limit: 50, offset: 0 },
  });

  const { listPendingReviews, castVote } = jest.requireMock(
    '../../src/services/validatorService',
  ) as { listPendingReviews: jest.Mock; castVote: jest.Mock };
  listPendingReviews.mockResolvedValue([]);
  castVote.mockResolvedValue({ finalized: true, status: 'APPROVED' });

  const { listDeadLetteredNotifications } = jest.requireMock(
    '../../src/services/notificationOutboxService',
  ) as { listDeadLetteredNotifications: jest.Mock };
  listDeadLetteredNotifications.mockResolvedValue({ items: [], total: 0 });

  const {
    listTasks,
    getTaskById,
    createTask,
    updateTask,
    deleteTask,
    completeTaskIfFull,
  } = jest.requireMock('../../src/models/task') as {
    listTasks: jest.Mock;
    getTaskById: jest.Mock;
    createTask: jest.Mock;
    updateTask: jest.Mock;
    deleteTask: jest.Mock;
    completeTaskIfFull: jest.Mock;
  };
  listTasks.mockResolvedValue({ items: [], nextCursor: null });
  getTaskById.mockResolvedValue({ id: 'task-1', title: 'Task' });
  createTask.mockImplementation((data: Record<string, unknown>) =>
    Promise.resolve({ id: 'task-1', ...data }),
  );
  updateTask.mockImplementation(
    (id: string, data: Record<string, unknown>) =>
      Promise.resolve({ id, ...data }),
  );
  deleteTask.mockResolvedValue({ id: 'task-1' });
  completeTaskIfFull.mockResolvedValue(false);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Authorization access matrix', () => {
  it('documents exactly the routes the test enforces', () => {
    const covered = new Set(CASES.map((c) => `${c.method} ${c.pattern}`));

    for (const entry of ROUTE_ACCESS_MATRIX) {
      expect(covered).toContain(`${entry.method} ${entry.path}`);
    }
    for (const c of CASES) {
      expect(
        ROUTE_ACCESS_MATRIX.some(
          (entry) => entry.method === c.method && entry.path === c.pattern,
        ),
      ).toBe(true);
    }
  });

  it.each<MatrixCase>(CASES)(
    '$method $pattern',
    async (c) => {
      const entry = ROUTE_ACCESS_MATRIX.find(
        (e) => e.method === c.method && e.path === c.pattern,
      );
      if (!entry) {
        throw new Error(`No matrix entry for ${c.method} ${c.pattern}`);
      }

      c.setup?.();

      const expected = {
        ...expectations(entry.access, c.allowedStatus, c.deniedStatus ?? 403),
        ...c.overrides,
      };

      const roles = c.rolesToTest ?? ROLES;
      for (const role of roles) {
        const want = expected[role];
        if (want === undefined) {
          continue;
        }
        const res = await send(c, role);
        if (want === ALLOW) {
          expect(res.status).not.toBe(401);
          expect(res.status).not.toBe(403);
        } else {
          expect(res.status).toBe(want);
        }
      }
    },
    20000,
  );
});
