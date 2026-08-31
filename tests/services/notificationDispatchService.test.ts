import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that resolve the module
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    notification: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../../src/config/default', () => ({
  __esModule: true,
  default: {
    notification: {
      webhookTimeoutMs: 5000,
      emailFrom: 'no-reply@ecotask.test',
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import prisma from '../../src/utils/prisma';
import {
  buildWebhookIdempotencyKey,
  dispatchNotification,
} from '../../src/services/notificationDispatchService';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockPrisma = prisma as unknown as {
  notification: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    userId: 'user-1',
    type: 'proof.approved',
    title: 'Proof approved',
    body: 'Your proof was approved.',
    channel: null,
    deliveredAt: null,
    deliveryError: null,
    readAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    user: {
      id: 'user-1',
      webhookUrl: 'https://consumer.example.com/webhook',
      email: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildWebhookIdempotencyKey — unit tests for the key derivation helper
// ---------------------------------------------------------------------------

describe('buildWebhookIdempotencyKey', () => {
  it('is deterministic: two calls with the same inputs produce the same key', () => {
    const key1 = buildWebhookIdempotencyKey('outbox-abc', 'https://example.com/wh');
    const key2 = buildWebhookIdempotencyKey('outbox-abc', 'https://example.com/wh');
    expect(key1).toBe(key2);
  });

  it('returns the expected SHA-256 hex digest', () => {
    const outboxId = 'outbox-abc';
    const url = 'https://example.com/wh';
    const expected = createHash('sha256')
      .update(`${outboxId}:${url}`)
      .digest('hex');
    expect(buildWebhookIdempotencyKey(outboxId, url)).toBe(expected);
  });

  it('produces different keys for the same outboxId but different webhook URLs', () => {
    const key1 = buildWebhookIdempotencyKey('outbox-xyz', 'https://consumer-a.example.com/wh');
    const key2 = buildWebhookIdempotencyKey('outbox-xyz', 'https://consumer-b.example.com/wh');
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different outboxIds but the same webhook URL', () => {
    const url = 'https://consumer.example.com/webhook';
    const key1 = buildWebhookIdempotencyKey('outbox-1', url);
    const key2 = buildWebhookIdempotencyKey('outbox-2', url);
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// dispatchNotification — integration-level tests asserting the header reaches
// the outbound fetch call
// ---------------------------------------------------------------------------

describe('dispatchNotification — Idempotency-Key header', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.notification.update.mockResolvedValue({});
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('sends Idempotency-Key header on the outbound webhook POST', async () => {
    const outboxId = 'outbox-idem-1';
    const webhookUrl = 'https://consumer.example.com/webhook';
    mockPrisma.notification.findUnique.mockResolvedValue(makeNotification());

    await dispatchNotification('notif-1', outboxId);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeDefined();
    expect(headers['Idempotency-Key']).toBe(
      buildWebhookIdempotencyKey(outboxId, webhookUrl),
    );
  });

  it('retry-stable: two calls with the same outboxId produce byte-identical Idempotency-Key values', async () => {
    const outboxId = 'outbox-retry-stable';
    mockPrisma.notification.findUnique.mockResolvedValue(makeNotification());

    // First attempt (simulate BullMQ attempt 1)
    await dispatchNotification('notif-1', outboxId);
    const [, init1] = mockFetch.mock.calls[0] as [string, RequestInit];

    mockFetch.mockClear();
    mockPrisma.notification.findUnique.mockResolvedValue(makeNotification());

    // Second attempt (simulate BullMQ retry, attempt 2)
    await dispatchNotification('notif-1', outboxId);
    const [, init2] = mockFetch.mock.calls[0] as [string, RequestInit];

    const headers1 = init1.headers as Record<string, string>;
    const headers2 = init2.headers as Record<string, string>;
    expect(headers1['Idempotency-Key']).toBe(headers2['Idempotency-Key']);
  });

  it('subscriber-unique: different outboxIds for the same URL produce different keys', async () => {
    // Simulate two separate logical deliveries to the same webhook URL
    const webhookUrl = 'https://consumer.example.com/webhook';

    mockPrisma.notification.findUnique.mockResolvedValue(makeNotification({ id: 'notif-1' }));
    await dispatchNotification('notif-1', 'outbox-gen1');
    const [, init1] = mockFetch.mock.calls[0] as [string, RequestInit];

    mockFetch.mockClear();
    mockPrisma.notification.findUnique.mockResolvedValue(makeNotification({ id: 'notif-1' }));
    await dispatchNotification('notif-1', 'outbox-gen2');
    const [, init2] = mockFetch.mock.calls[0] as [string, RequestInit];

    const key1 = (init1.headers as Record<string, string>)['Idempotency-Key'];
    const key2 = (init2.headers as Record<string, string>)['Idempotency-Key'];

    expect(key1).not.toBe(key2);
    // Sanity-check each key matches what buildWebhookIdempotencyKey would return
    expect(key1).toBe(buildWebhookIdempotencyKey('outbox-gen1', webhookUrl));
    expect(key2).toBe(buildWebhookIdempotencyKey('outbox-gen2', webhookUrl));
  });

  it('falls back to notificationId as key base when outboxId is omitted', async () => {
    const webhookUrl = 'https://consumer.example.com/webhook';
    mockPrisma.notification.findUnique.mockResolvedValue(makeNotification());

    // Call without outboxId (e.g. direct admin call)
    await dispatchNotification('notif-1');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(
      buildWebhookIdempotencyKey('notif-1', webhookUrl),
    );
  });

  it('preserves Content-Type header alongside the Idempotency-Key', async () => {
    mockPrisma.notification.findUnique.mockResolvedValue(makeNotification());

    await dispatchNotification('notif-1', 'outbox-ct-check');

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Idempotency-Key']).toBeDefined();
  });

  it('does not call fetch and returns delivered:true when notification is already delivered', async () => {
    mockPrisma.notification.findUnique.mockResolvedValue(
      makeNotification({ deliveredAt: new Date() }),
    );

    const result = await dispatchNotification('notif-1', 'outbox-already-done');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.delivered).toBe(true);
  });
});
