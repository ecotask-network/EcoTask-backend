import express from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../../src/middleware/requestId';
import logger from '../../src/utils/logger';

describe('requestIdMiddleware', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a UUID and applies the same requestId to request logs', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const app = express();

    app.use(requestIdMiddleware);
    app.get('/test', (req, res) => {
      logger.info('inside request');
      res.json({ requestId: req.requestId });
    });

    const response = await request(app).get('/test');
    const requestId = response.headers['x-request-id'];

    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.body.requestId).toBe(requestId);

    const logs = logSpy.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(logs.map((entry) => entry.msg)).toEqual([
      'inside request',
      'HTTP request completed',
    ]);
    expect(new Set(logs.map((entry) => entry.requestId))).toEqual(new Set([requestId]));
    expect(logs[1].path).toBe('/test');
  });
});
