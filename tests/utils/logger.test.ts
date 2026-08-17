import { createLogger } from '../../src/utils/logger';

describe('structured logger', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('serializes errors with their diagnostic fields', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const logger = createLogger();
    const err = Object.assign(new Error('database unavailable'), {
      code: 'ECONNREFUSED',
    });

    logger.error('request failed', { err });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(output.err).toEqual({
      message: 'database unavailable',
      name: 'Error',
      stack: expect.stringContaining('Error: database unavailable'),
      code: 'ECONNREFUSED',
    });
  });

  it('does not throw for circular, AggregateError, BigInt, or hostile payloads', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const logger = createLogger();
    const circular: Record<string, unknown> = { count: 42n };
    circular.self = circular;
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('cannot enumerate');
        },
      },
    );
    const err = new AggregateError([new Error('first failure'), 99n], 'many failures', {
      cause: circular,
    });

    expect(() =>
      logger.error('unusual payload', { circular, err, hostile }),
    ).not.toThrow();

    const output = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(output.circular).toEqual({ count: '42', self: '[Circular]' });
    expect(output.err).toEqual(
      expect.objectContaining({
        message: 'many failures',
        name: 'AggregateError',
        errors: [
          expect.objectContaining({ message: 'first failure', name: 'Error' }),
          '99',
        ],
      }),
    );
    expect(output.hostile).toBe('[Unserializable]');
  });

  it('redacts sensitive fields and supports additional redaction hooks', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const logger = createLogger({
      redactors: [
        ({ path, value }) =>
          path.join('.') === 'profile.email' ? '[MASKED EMAIL]' : value,
      ],
    });

    const err = Object.assign(new Error('delivery failed'), {
      clientSecret: 'provider-secret',
    });

    logger.warn('redaction check', {
      password: 'open sesame',
      nested: {
        authorization: 'Bearer public-token',
        apiKey: 'api-key-value',
      },
      profile: { email: 'user@example.com', displayName: 'User' },
      err,
    });

    const output = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(output.password).toBe('[REDACTED]');
    expect(output.nested).toEqual({
      authorization: '[REDACTED]',
      apiKey: '[REDACTED]',
    });
    expect(output.profile).toEqual({
      email: '[MASKED EMAIL]',
      displayName: 'User',
    });
    expect(output.err.clientSecret).toBe('[REDACTED]');
  });

  it('filters messages below the configured level', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const logger = createLogger({ level: 'warn' });

    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
