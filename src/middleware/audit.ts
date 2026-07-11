import { Request, Response, NextFunction } from "express";
import { logAudit } from "../services/auditService.js";

export function auditMiddleware(action: string, resource: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const resourceId = req.params.id || req.body?.id || undefined;

    logAudit({
      userId: req.user?.userId,
      action,
      resource,
      resourceId,
      details: {
        method: req.method,
        path: req.path,
        body: req.method !== "GET" ? req.body : undefined,
      },
      ip: req.ip,
    }).catch(() => {});

    next();
  };
}
