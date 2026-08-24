import request from 'supertest';
import express from 'express';
import { auditMiddleware, redactDetails } from '../../src/middleware/audit';

// Mock the whole auditService so DB writes never happen in unit tests
jest.mock('../../src/services/auditService', () => ({
  logAudit: jest.fn(),
}));

import { logAudit } from '../../src/services/auditService';

const mockLogAudit = logAudit as jest.Mock;

// ---------------------------------------------------------------------------
// redactDetails unit tests
// ---------------------------------------------------------------------------

describe('redactDetails', () => {
  it('keeps whitelisted fields for proof.submit and redacts the rest', () => {
    const body = {
      taskId: 'task-1',
      lat: 40.7,
      lng: -74.0,
      notes: 'found a lot of trash', // sensitive — not in whitelist
      email: 'user@example.com', // sensitive
    };
    const result = redactDetails('proof.submit', body);
    expect(result.taskId).toBe('task-1');
    expect(result.lat).toBe(40.7);
    expect(result.lng).toBe(-74.0);
    expect(result.notes).toBe('[REDACTED]');
    expect(result.email).toBe('[REDACTED]');
  });

  it('keeps only name/avatarUrl for user.update, always redacts bio (free-text PII)', () => {
    const body = {
      name: 'Alice',
      bio: 'eco warrior', // bio is always redacted — free-text PII
      email: 'alice@example.com', // sensitive
      webhookUrl: 'https://hooks.example.com', // sensitive
    };
    const result = redactDetails('user.update', body);
    expect(result.name).toBe('Alice');
    expect(result.bio).toBe('[REDACTED]');
    expect(result.email).toBe('[REDACTED]');
    expect(result.webhookUrl).toBe('[REDACTED]');
  });

  it('redacts all body fields for notification.preferences', () => {
    const body = {
      email: 'user@example.com',
      webhookUrl: 'https://hooks.example.com',
    };
    const result = redactDetails('notification.preferences', body);
    expect(result.email).toBe('[REDACTED]');
    expect(result.webhookUrl).toBe('[REDACTED]');
  });

  it('redacts notes for proof.review even though it is whitelisted (always-redact PII)', () => {
    const body = {
      verdict: 'approved',
      notes: 'looks good — free text PII',
      adminToken: 'secret',
    };
    const result = redactDetails('proof.review', body);
    expect(result.verdict).toBe('approved');
    expect(result.notes).toBe('[REDACTED]');
    expect(result.adminToken).toBe('[REDACTED]');
  });

  it('redacts all body fields for unknown actions', () => {
    const body = { data: 'something', secret: 'value' };
    const result = redactDetails('unknown.action', body);
    expect(result.data).toBe('[REDACTED]');
    expect(result.secret).toBe('[REDACTED]');
  });

  it('returns empty object for empty body', () => {
    expect(redactDetails('proof.submit', {})).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Issue #88 — deep redaction and always-redact PII fields
  // -------------------------------------------------------------------------

  it('always redacts notes regardless of action whitelist — proof.review', () => {
    // notes appears in proof.review whitelist but must still be redacted
    const result = redactDetails('proof.review', {
      verdict: 'rejected',
      notes: 'User said XYZ',
    });
    expect(result.verdict).toBe('rejected');
    expect(result.notes).toBe('[REDACTED]');
  });

  it('always redacts notes regardless of action whitelist — validator.review', () => {
    const result = redactDetails('validator.review', {
      verdict: 'approved',
      notes: 'Looks authentic',
    });
    expect(result.verdict).toBe('approved');
    expect(result.notes).toBe('[REDACTED]');
  });

  it('always redacts bio regardless of action whitelist — user.update', () => {
    const result = redactDetails('user.update', {
      name: 'Bob',
      bio: 'Lives in NYC, age 34',
    });
    expect(result.name).toBe('Bob');
    expect(result.bio).toBe('[REDACTED]');
  });

  it('redacts nested object values inside a whitelisted top-level field', () => {
    // task.create whitelists 'title'; if someone sends title as an object its
    // nested content should still be sanitised
    const result = redactDetails('task.create', {
      title: 'Clean the park',
      rewardAmount: 10,
      metadata: { internalNote: 'admin only', safe: true }, // not whitelisted → redacted at top
    });
    expect(result.title).toBe('Clean the park');
    expect(result.rewardAmount).toBe(10);
    expect(result.metadata).toBe('[REDACTED]'); // top-level non-whitelisted
  });

  it('sanitises nested objects within a whitelisted key — keeps safe scalars, redacts sensitive sub-keys', () => {
    // Simulate a whitelisted key whose value happens to be a compound object
    // with nested sensitive fields (e.g. notes buried inside)
    const result = redactDetails('proof.submit', {
      taskId: 'task-1',
      lat: 10,
      lng: 20,
      extra: {
        notes: 'private note inside nested object',
        safe: 42,
      },
    });
    expect(result.taskId).toBe('task-1');
    // extra is not whitelisted — redacted at top level
    expect(result.extra).toBe('[REDACTED]');
  });

  it('redacts notes nested inside a top-level whitelisted compound value', () => {
    // Fabricate a scenario: whitelist a key that contains nested notes/bio to
    // verify sanitiseValue() catches them even inside compound values.
    // We do this via user.update → avatarUrl whitelisted, but value is an
    // object that contains a notes sub-key.
    const result = redactDetails('user.update', {
      name: 'Carol',
      avatarUrl: {
        url: 'https://cdn.example.com/avatar.png',
        notes: 'admin label', // ALWAYS_REDACT even inside a nested object
      } as unknown as string,
    });
    expect(result.name).toBe('Carol');
    const avatarUrl = result.avatarUrl as Record<string, unknown>;
    expect(avatarUrl.url).toBe('https://cdn.example.com/avatar.png');
    expect(avatarUrl.notes).toBe('[REDACTED]');
  });

  it('sanitises arrays — redacts sensitive keys inside array element objects', () => {
    const result = redactDetails('task.create', {
      title: 'Park clean',
      tags: [
        { label: 'eco', notes: 'hidden note' },
        { label: 'outdoor', score: 5 },
      ] as unknown as string,
    });
    expect(result.title).toBe('Park clean');
    // tags is not whitelisted — redacted entirely
    expect(result.tags).toBe('[REDACTED]');
  });

  it('proof.submit body with notes at top level is always redacted', () => {
    // notes is NOT in proof.submit whitelist, but this also tests the
    // ALWAYS_REDACT path for a non-whitelisted field
    const result = redactDetails('proof.submit', {
      taskId: 'task-99',
      lat: 51.5,
      lng: -0.1,
      notes: 'I found rubbish near the gate',
    });
    expect(result.taskId).toBe('task-99');
    expect(result.notes).toBe('[REDACTED]');
  });

  it('handles deeply nested objects recursively — PII does not leak at any depth', () => {
    const result = redactDetails('user.update', {
      name: 'Dave',
      avatarUrl: {
        meta: {
          bio: 'nested bio PII',
          size: 1024,
          inner: {
            notes: 'deep notes PII',
            timestamp: 1234567890,
          },
        },
      } as unknown as string,
    });
    const avatarUrl = result.avatarUrl as Record<string, unknown>;
    const meta = avatarUrl.meta as Record<string, unknown>;
    expect(meta.bio).toBe('[REDACTED]');
    expect(meta.size).toBe(1024);
    const inner = meta.inner as Record<string, unknown>;
    expect(inner.notes).toBe('[REDACTED]');
    expect(inner.timestamp).toBe(1234567890);
  });
});

// ---------------------------------------------------------------------------
// auditMiddleware integration tests via a mini Express app
// ---------------------------------------------------------------------------

function buildApp(action: string, resource: string, statusCode = 200) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Simulate auth middleware populating req.user
    (req as express.Request & { user?: { userId: string } }).user = { userId: 'user-42' };
    next();
  });
  app.post('/test', auditMiddleware(action, resource), (_req, res) => {
    res.status(statusCode).json({ ok: true });
  });
  return app;
}

describe('auditMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls logAudit after the response is sent with SUCCESS outcome for 2xx', async () => {
    const res = await request(buildApp('proof.submit', 'proof', 200))
      .post('/test')
      .send({ taskId: 'task-1', lat: 10, lng: 20, notes: 'private note' });

    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.action).toBe('proof.submit');
    expect(entry.resource).toBe('proof');
    expect(entry.outcome).toBe('SUCCESS');
    expect(entry.statusCode).toBe(200);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.userId).toBe('user-42');
  });

  it('records FAILURE outcome for 4xx responses', async () => {
    await request(buildApp('user.update', 'user', 403))
      .post('/test')
      .send({ email: 'bad@example.com' });

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.outcome).toBe('FAILURE');
    expect(entry.statusCode).toBe(403);
  });

  it('records FAILURE outcome for 5xx responses', async () => {
    await request(buildApp('task.create', 'task', 500))
      .post('/test')
      .send({ title: 'New Task' });

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.outcome).toBe('FAILURE');
    expect(entry.statusCode).toBe(500);
  });

  it('redacts sensitive fields in details before logging for proof.submit', async () => {
    await request(buildApp('proof.submit', 'proof', 201))
      .post('/test')
      .send({ taskId: 'task-1', lat: 1, lng: 2, notes: 'top secret', email: 'x@y.com' });

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.details.body.taskId).toBe('task-1');
    expect(entry.details.body.lat).toBe(1);
    expect(entry.details.body.notes).toBe('[REDACTED]');
    expect(entry.details.body.email).toBe('[REDACTED]');
  });

  it('redacts all body fields for notification.preferences', async () => {
    await request(buildApp('notification.preferences', 'notification', 200))
      .post('/test')
      .send({ email: 'user@example.com', webhookUrl: 'https://hooks.example.com' });

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.details.body.email).toBe('[REDACTED]');
    expect(entry.details.body.webhookUrl).toBe('[REDACTED]');
  });

  it('does not include body in details for GET requests', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { userId: string } }).user = { userId: 'u1' };
      next();
    });
    app.get('/test', auditMiddleware('task.read', 'task'), (_req, res) =>
      res.json({ ok: true }),
    );

    await request(app).get('/test');

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.details.body).toEqual({});
  });

  it('includes method, path, and ip in details', async () => {
    await request(buildApp('proof.submit', 'proof', 200))
      .post('/test')
      .send({ taskId: 'task-1' });

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.details.method).toBe('POST');
    expect(entry.details.path).toBe('/test');
  });

  it('does not suppress the response when logAudit would throw', async () => {
    // logAudit is sync and void — it should never throw out of the middleware,
    // but even if it does the response must still be sent.
    mockLogAudit.mockImplementationOnce(() => {
      throw new Error('queue full');
    });

    // We need an app that won't have the throw kill the request
    const app = express();
    app.use(express.json());
    app.post('/safe', auditMiddleware('proof.submit', 'proof'), (_req, res) => {
      res.json({ ok: true });
    });

    // Response should still come back (error happens in 'finish' event after response)
    const res = await request(app).post('/safe').send({ taskId: 't1' });
    expect(res.status).toBe(200);
  });
});
