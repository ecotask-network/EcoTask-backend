import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { rateLimiter } from '../services/rateLimitService.js';
import config from '../config/default.js';
import logger from '../utils/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts' },
});

export const proofLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: { error: 'Too many proof submissions' },
});

export interface PerUserLimitOptions {
  windowMs: number;
  max: number;
  scope: string;
}

/**
 * Per-user (or per-IP for anonymous callers) fixed-window limiter backed by
 * Redis. Fails open if Redis is unreachable so an infra hiccup never blocks
 * legitimate traffic.
 */
export function perUserLimiter(options: PerUserLimitOptions) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const clientId = req.user?.userId || req.ip || 'unknown';
    const key = `rl:${options.scope}:${clientId}`;

    try {
      const result = await rateLimiter.check(key, options.max, options.windowMs);
      res.setHeader('RateLimit-Limit', String(options.max));
      res.setHeader('RateLimit-Remaining', String(result.remaining));
      res.setHeader('RateLimit-Reset', String(result.retryAfterSeconds));

      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        return res
          .status(429)
          .json({ error: 'Too many requests, please try again later' });
      }

      next();
    } catch (err) {
      logger.warn('Per-user rate limiter unavailable, allowing request', { err });
      next();
    }
  });
}

export const proofSubmissionLimiter = perUserLimiter({
  windowMs: config.rateLimit.proofWindowMs,
  max: config.rateLimit.proofMax,
  scope: 'proof-submit',
});

export const claimLimiter = perUserLimiter({
  windowMs: config.rateLimit.claimWindowMs,
  max: config.rateLimit.claimMax,
  scope: 'task-claim',
});
