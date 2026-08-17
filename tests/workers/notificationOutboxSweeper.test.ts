import {
  startOutboxSweeper,
  stopOutboxSweeper,
} from '../../src/workers/notificationOutboxSweeper';

jest.mock('../../src/services/notificationOutboxService', () => ({
  drainNotificationOutbox: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../../src/config/default', () => ({
  __esModule: true,
  default: { notification: { outboxSweepIntervalMs: 60000 } },
}));

import { drainNotificationOutbox } from '../../src/services/notificationOutboxService';

describe('Notification Outbox Sweeper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stopOutboxSweeper();
    jest.useRealTimers();
  });

  afterEach(() => {
    stopOutboxSweeper();
    jest.useRealTimers();
  });

  it('runs an initial drain on start and schedules recurring drains', () => {
    (drainNotificationOutbox as jest.Mock).mockResolvedValue({
      claimed: 0,
      sent: 0,
      retried: 0,
      deadLettered: 0,
    });
    jest.useFakeTimers();

    startOutboxSweeper(60000);

    expect(drainNotificationOutbox).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60000);
    expect(drainNotificationOutbox).toHaveBeenCalledTimes(2);
  });

  it('stopOutboxSweeper halts further sweeps', () => {
    (drainNotificationOutbox as jest.Mock).mockResolvedValue({
      claimed: 0,
      sent: 0,
      retried: 0,
      deadLettered: 0,
    });
    jest.useFakeTimers();

    startOutboxSweeper(60000);
    stopOutboxSweeper();
    jest.advanceTimersByTime(60000 * 3);

    expect(drainNotificationOutbox).toHaveBeenCalledTimes(1);
  });

  it('does not start a second timer if already running', () => {
    (drainNotificationOutbox as jest.Mock).mockResolvedValue({
      claimed: 0,
      sent: 0,
      retried: 0,
      deadLettered: 0,
    });
    jest.useFakeTimers();

    startOutboxSweeper(60000);
    startOutboxSweeper(60000);

    expect(drainNotificationOutbox).toHaveBeenCalledTimes(1);
  });
});
