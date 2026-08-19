import { Request, Response, NextFunction } from 'express';

export async function adminMiddleware(req: Request, res: Response, next: NextFunction) {
  // authMiddleware resolves the user's current role from the database, so a
  // deleted or demoted user is rejected here without an extra DB lookup.
  if (!req.user?.role) {
    return res.status(401).json({ error: 'authentication required' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin access required' });
  }

  next();
}
