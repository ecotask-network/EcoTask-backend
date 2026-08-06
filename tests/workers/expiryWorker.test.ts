import { startExpirySweeper, stopExpirySweeper } from '../../src/workers/expiryWorker';

jest.mock('../../src/services/taskService', () => ({
  expireOverdueTasks: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../../src/config/default', () => ({
  __esModule: true,
  default: { expirySweepIntervalMs: 60000 },
}));

import { expireOverdueTasks } from '../../src/services/taskService';

describe('Expiry Worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stopExpirySweeper();
    jest.useRealTimers();
  });

  afterEach(() => {
    stopExpirySweeper();
    jest.useRealTimers();
  });

  it('runs an initial sweep on start and schedules recurring sweeps', () => {
    (expireOverdueTasks as jest.Mock).mockResolvedValue({
      tasksExpired: 0,
      claimsExpired: 0,
    });
    jest.useFakeTimers();

    startExpirySweeper(60000);

    expect(expireOverdueTasks).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60000);
    expect(expireOverdueTasks).toHaveBeenCalledTimes(2);
  });

  it('stopExpirySweeper halts further sweeps', () => {
    (expireOverdueTasks as jest.Mock).mockResolvedValue({
      tasksExpired: 0,
      claimsExpired: 0,
    });
    jest.useFakeTimers();

    startExpirySweeper(60000);
    stopExpirySweeper();
    jest.advanceTimersByTime(60000 * 3);

    expect(expireOverdueTasks).toHaveBeenCalledTimes(1);
  });
});
