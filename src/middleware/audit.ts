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
 *
 * Note: even if a field appears in this whitelist it will still be redacted
 * if it is also listed in ALWAYS_REDACT_FIELDS (e.g. `notes`, `bio`).
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
 * Fields that contain free-text user input and must ALWAYS be redacted,
 * regardless of whether they appear in the action's whitelist. This covers
 * known PII-bearing fields such as proof/validator review notes and user bios.
 */
const ALWAYS_REDACT_FIELDS = new Set<string>(['notes', 'bio']);

/**
 * Recursively sanitise a value that was reached via a whitelisted key.
 *
 * - Primitive scalars (string, number, boolean, null) are returned as-is.
 * - Arrays are mapped through this function element-by-element; non-scalar
 *   elements that are not plain objects are replaced with "[REDACTED]".
 * - Plain objects are recursively processed: only primitive-valued keys that
 *   are NOT in ALWAYS_REDACT_FIELDS survive; everything else is redacted.
 *
 * This prevents nested PII from leaking through whitelisted compound values.
 */
function sanitiseValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    // Primitive scalar — safe as-is
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      item === null || typeof item !== 'object' ? item : sanitiseValue(item),
    );
  }

  // Plain object — keep only primitive-valued, non-sensitive keys
  const obj = value as Record<string, unknown>;
  const sanitised: Record<string, unknown> = {};

  for (const key of Object.keys(obj)) {
    if (ALWAYS_REDACT_FIELDS.has(key)) {
      sanitised[key] = '[REDACTED]';
    } else if (obj[key] === null || typeof obj[key] !== 'object') {
      sanitised[key] = obj[key];
    } else {
      sanitised[key] = sanitiseValue(obj[key]);
    }
  }

  return sanitised;
}

/**
 * Return a copy of `body` safe to persist in the audit log.
 *
 * Rules applied in order:
 *  1. Any field in ALWAYS_REDACT_FIELDS is replaced with "[REDACTED]"
 *     regardless of the action whitelist (e.g. `notes`, `bio`).
 *  2. Any field not in the action's whitelist is replaced with "[REDACTED]".
 *  3. Whitelisted, non-sensitive fields whose value is a nested object or
 *     array are passed through sanitiseValue(), which recursively applies
 *     the same rules so nested PII is never stored verbatim.
 *
 * Unknown actions whitelist nothing, so every field is redacted.
 */
export function redactDetails(
  action: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = FIELD_WHITELIST[action] ?? new Set<string>();
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(body)) {
    if (ALWAYS_REDACT_FIELDS.has(key)) {
      // Always redact known free-text PII fields, even if whitelisted
      result[key] = '[REDACTED]';
    } else if (!allowed.has(key)) {
      result[key] = '[REDACTED]';
    } else {
      // Whitelisted key — sanitise nested structures before storing
      result[key] = sanitiseValue(body[key]);
    }
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
