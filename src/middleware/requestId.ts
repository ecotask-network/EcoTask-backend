import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';
import { runWithRequestContext } from '../utils/requestContext.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  const requestPath = req.path;

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithRequestContext(requestId, () => {
    res.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.info('HTTP request completed', {
        method: req.method,
        path: requestPath,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(3)),
        requestId,
      });
    });

    next();
  });
}
