import { dispatchNotification } from '../../src/services/notificationDispatchService';

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    notification: { findUnique: jest.fn(), update: jest.fn() },
  },
}));

jest.mock('../../src/config/default', () => ({
  notification: {
    webhookTimeoutMs: 1000,
    emailFrom: 'EcoTask <no-reply@ecotask.network>',
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  notification: { findUnique: jest.Mock; update: jest.Mock };
};

const mockFetch = jest.fn();
beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});
afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (global as any).fetch;
});

function baseNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    type: 'proof.approved',
    title: 'Proof approved',
    body: 'Your proof was approved',
    createdAt: new Date(),
    deliveredAt: null,
    channel: null,
    deliveryError: null,
    user: { email: null, webhookUrl: null },
    ...overrides,
  };
}

describe('NotificationDispatchService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('delivers via webhook when the user has a webhook URL', async () => {
    mockPrisma.notification.findUnique.mockResolvedValue(
      baseNotification({
        user: { email: null, webhookUrl: 'https://hooks.example.com/ecotask' },
      }),
    );
    mockPrisma.notification.update.mockResolvedValue({});

    const result = await dispatchNotification('n-1');

    expect(result).toEqual({ channel: 'webhook', delivered: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.example.com/ecotask',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"title":"Proof approved"'),
      }),
    );
    expect(mockPrisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n-1' },
      data: {
        channel: 'webhook',
        deliveredAt: expect.any(Date),
        deliveryError: null,
      },
    });
  });

  it('records the error when the webhook endpoint fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    mockPrisma.notification.findUnique.mockResolvedValue(
      baseNotification({
        user: { email: null, webhookUrl: 'https://hooks.example.com/fail' },
      }),
    );
    mockPrisma.notification.update.mockResolvedValue({});

    const result = await dispatchNotification('n-1');

    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/500/);
    expect(mockPrisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n-1' },
      data: {
        channel: 'webhook',
        deliveredAt: null,
        deliveryError: expect.stringContaining('500'),
      },
    });
  });

  it('marks email as the channel when only an email is configured', async () => {
    mockPrisma.notification.findUnique.mockResolvedValue(
      baseNotification({ user: { email: 'user@example.com', webhookUrl: null } }),
    );
    mockPrisma.notification.update.mockResolvedValue({});

    const result = await dispatchNotification('n-1');

    expect(result).toEqual({ channel: 'email', delivered: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to inbox-only delivery when no external channel is set', async () => {
    mockPrisma.notification.findUnique.mockResolvedValue(baseNotification());
    mockPrisma.notification.update.mockResolvedValue({});

    const result = await dispatchNotification('n-1');

    expect(result).toEqual({ channel: 'inbox', delivered: true });
    expect(mockPrisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n-1' },
      data: { channel: 'inbox', deliveredAt: expect.any(Date), deliveryError: null },
    });
  });

  it('skips redelivery for notifications already delivered', async () => {
    mockPrisma.notification.findUnique.mockResolvedValue(
      baseNotification({ deliveredAt: new Date(), channel: 'email' }),
    );

    const result = await dispatchNotification('n-1');

    expect(result).toEqual({ channel: 'email', delivered: true });
    expect(mockPrisma.notification.update).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns a failure result for a missing notification', async () => {
    mockPrisma.notification.findUnique.mockResolvedValue(null);

    const result = await dispatchNotification('nope');

    expect(result.delivered).toBe(false);
    expect(mockPrisma.notification.update).not.toHaveBeenCalled();
  });
});
