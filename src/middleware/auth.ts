import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/default.js';
import { rateLimiter } from '../services/rateLimitService.js';
import logger from '../utils/logger.js';

const createAuthMiddleware =
  (strict: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing authorization header' });
    }

    let payload: jwt.JwtPayload & { userId: string; wallet: string };
    try {
      const token = header.slice(7);
      payload = jwt.verify(token, config.jwt.secret, {
        algorithms: ['HS256'],
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      });
    } catch {
      return res.status(401).json({ error: 'invalid token' });
    }

    if (payload.jti) {
      try {
        const client = rateLimiter.getClient();
        const isRevoked = await client.get(`jwt_denylist:${payload.jti}`);
        if (isRevoked) {
          return res.status(401).json({ error: 'token revoked' });
        }
      } catch (err) {
        logger.error('Redis error during JWT revocation check', { err });
        if (strict) {
          return res.status(503).json({ error: 'auth service unavailable' });
        }
        // fail open
      }
    }

    req.user = payload;
    next();
  };

export const authMiddleware = createAuthMiddleware(false);
export const strictAuthMiddleware = createAuthMiddleware(true);
