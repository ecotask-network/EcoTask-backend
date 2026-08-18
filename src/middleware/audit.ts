import { Request, Response, NextFunction } from 'express';
import { logAudit, AuditOutcome } from '../services/auditService.js';

// ---------------------------------------------------------------------------
// Sensitive-field redaction
//
// Each action has an explicit whitelist of safe top-level body fields. Any
// field not on the whitelist is replaced with "[REDACTED]" before it reaches
// the audit log. This prevents raw email addresses, webhook URLs, proof notes,
// and other PII from being persisted verbatim.
// ---------------------------------------------------------------------------

/**
 * Top-level request body fields that are safe to record for each action.
 * Anything not listed here is redacted.
 */
const FIELD_WHITELIST: Record<string, Set<string>> = {
  'proof.submit': new Set(['taskId', 'lat', 'lng']),
  'proof.review': new Set(['verdict', 'notes']),
  'user.update': new Set(['name', 'bio', 'avatarUrl']),
  'notification.preferences': new Set([]), // no body fields are safe to log
  'task.create': new Set([
    'title',
    'type',
    'rewardAmount',
    'rewardToken',
    'lat',
    'lng',
    'radiusMeters',
    'maxCompletions',
    'status',
    'expiresAt',
  ]),
  'task.update': new Set([
    'title',
    'type',
    'rewardAmount',
    'rewardToken',
    'lat',
    'lng',
    'radiusMeters',
    'maxCompletions',
    'status',
    'expiresAt',
  ]),
  'task.delete': new Set([]),
  'validator.activate': new Set([]),
  'validator.deactivate': new Set([]),
  'validator.review': new Set(['verdict', 'notes']),
};

/**
 * Return a copy of `body` with any field not in the whitelist for `action`
 * replaced by the string "[REDACTED]". Unknown actions whitelist nothing.
 */
export function redactDetails(
  action: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = FIELD_WHITELIST[action] ?? new Set<string>();
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(body)) {
    result[key] = allowed.has(key) ? body[key] : '[REDACTED]';
  }

  return result;
}

// ---------------------------------------------------------------------------
// Middleware
//
// Wraps res.json and the 'finish' event so the audit record is written AFTER
// the response has left the wire, carrying the actual HTTP status code, an
// outcome (SUCCESS / FAILURE), and the wall-clock duration of the request.
// ---------------------------------------------------------------------------

export function auditMiddleware(action: string, resource: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startMs = Date.now();
    const resourceId = req.params.id || req.body?.id || undefined;

    // Capture a sanitised snapshot of the request body *now*, before any
    // downstream middleware mutates it (e.g. multer populates req.body after
    // upload middleware runs). For multipart requests the body may be empty
    // at this point — that is fine; we only want named JSON fields anyway.
    const rawBody: Record<string, unknown> =
      req.method !== 'GET' && req.body != null && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>)
        : {};

    const details = {
      method: req.method,
      path: req.path,
      body: redactDetails(action, rawBody),
    };

    // 'finish' fires once the response headers and body have been flushed to
    // the OS network buffer — i.e. after the handler and any send() call.
    res.on('finish', () => {
      try {
        const statusCode = res.statusCode;
        const durationMs = Date.now() - startMs;
        const outcome: AuditOutcome = statusCode < 400 ? 'SUCCESS' : 'FAILURE';

        logAudit({
          userId: req.user?.userId,
          action,
          resource,
          resourceId,
          details,
          ip: req.ip,
          outcome,
          statusCode,
          durationMs,
        });
      } catch {
        // logAudit is synchronous and void; errors here must never propagate
        // back into the event loop in a way that crashes Node or affects the
        // already-sent response.
      }
    });

    next();
  };
}
