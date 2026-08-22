import { EventEmitter } from 'events';
import type { Redis, RedisOptions } from 'ioredis';
import {
  RedisConnectionManager,
  exponentialBackoffRetryStrategy,
} from '../../src/utils/redisConnectionManager';

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('../../src/config/default', () => ({
  redis: { url: 'redis://localhost:6379' },
}));

type RedisStatus =
  | 'wait'
  | 'reconnecting'
  | 'connecting'
  | 'connect'
  | 'ready'
  | 'close'
  | 'end';

class FakeRedis extends EventEmitter {
  status: RedisStatus = 'wait';
  ping = jest.fn(async () => 'PONG');
  quit = jest.fn(async () => 'OK');
  disconnect = jest.fn();
}

const asFactory = (fn: () => FakeRedis) =>
  fn as unknown as (url: string, options: RedisOptions) => Redis;

describe('RedisConnectionManager', () => {
  it('creates the shared client lazily and returns the same instance on every call', () => {
    const createClient = jest.fn(() => new FakeRedis());
    const manager = new RedisConnectionManager({
      url: 'redis://localhost:6379',
      createClient: asFactory(createClient),
    });

    expect(createClient).not.toHaveBeenCalled();

    const first = manager.getClient();
    const second = manager.getClient();

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('handles a dropped connection uniformly and becomes unhealthy without crashing', () => {
    const client = new FakeRedis();
    client.status = 'ready';
    const manager = new RedisConnectionManager({
      url: 'redis://localhost:6379',
      createClient: asFactory(() => client),
    });

    manager.getClient();
    expect(manager.isHealthy()).toBe(true);

    // ioredis emits 'error' then 'close'/'end' when the socket drops. The
    // manager must swallow the 'error' event (no unhandled exception) and log
    // both the error and the close, updating its health signal as it goes.
    expect(() => {
      client.emit('error', new Error('ECONNRESET'));
      client.emit('close');
    }).not.toThrow();

    client.status = 'close';
    expect(manager.isHealthy()).toBe(false);

    const logger = jest.requireMock('../../src/utils/logger').default as {
      error: jest.Mock;
      warn: jest.Mock;
    };
    expect(logger.error).toHaveBeenCalledWith(
      'Redis connection error',
      expect.objectContaining({ err: expect.any(Error) }),
    );
    expect(logger.warn).toHaveBeenCalledWith('Redis connection closed');
  });

  it('reports healthy when the connection is ready and ping succeeds', async () => {
    const client = new FakeRedis();
    client.status = 'ready';
    const manager = new RedisConnectionManager({
      url: 'redis://localhost:6379',
      createClient: asFactory(() => client),
    });

    await expect(manager.healthCheck()).resolves.toEqual({
      healthy: true,
      status: 'ready',
    });
    expect(client.ping).toHaveBeenCalled();
  });

  it('short-circuits the health check without issuing a command when not ready', async () => {
    const client = new FakeRedis();
    client.status = 'reconnecting';
    const manager = new RedisConnectionManager({
      url: 'redis://localhost:6379',
      createClient: asFactory(() => client),
    });

    await expect(manager.healthCheck()).resolves.toEqual({
      healthy: false,
      status: 'reconnecting',
    });
    expect(client.ping).not.toHaveBeenCalled();
  });

  it('reports a timeout when the ping never resolves', async () => {
    const client = new FakeRedis();
    client.status = 'ready';
    client.ping.mockImplementation(() => new Promise(() => undefined));
    const manager = new RedisConnectionManager({
      url: 'redis://localhost:6379',
      createClient: asFactory(() => client),
    });

    await expect(manager.healthCheck(50)).resolves.toEqual({
      healthy: false,
      status: 'timeout',
    });
  });

  it('closes the shared client and allows it to be re-created', async () => {
    const first = new FakeRedis();
    const second = new FakeRedis();
    const clients = [first, second];
    let calls = 0;
    const manager = new RedisConnectionManager({
      url: 'redis://localhost:6379',
      createClient: asFactory(() => clients[calls++]),
    });

    expect(manager.getClient()).toBe(first);
    await manager.close();
    expect(first.quit).toHaveBeenCalled();

    expect(manager.getClient()).toBe(second);
    expect(manager.getClient()).toBe(second);
  });

  it('bounds the shared reconnection backoff by a maximum delay', () => {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const delay = exponentialBackoffRetryStrategy(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(30_500);
    }
  });
});
