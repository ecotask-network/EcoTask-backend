/**
 * Composite cursor helpers for `(createdAt, id)` keyset pagination.
 *
 * Encodes both the `createdAt` timestamp and the row `id` into an opaque
 * base64url token so that pages can be disambiguated even when many rows
 * share an identical `createdAt` (e.g. seeded/backfilled data where
 * timestamps collide at millisecond resolution).
 */

export interface CompositeCursor {
  createdAt: string;
  /**
   * The tie-breaker id. `undefined` when decoding a legacy bare-date
   * cursor (see `decodeCursor` below) — callers must fall back to an
   * `createdAt`-only comparison in that case.
   */
  id?: string;
}

export class InvalidCursorError extends Error {
  constructor(message = 'invalid cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/**
 * Encode a composite `(createdAt, id)` cursor as an opaque base64url token.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
    'base64url',
  );
}

/**
 * Decode a cursor produced by `encodeCursor`, while remaining backward
 * compatible with the pre-composite-cursor format (a bare ISO date string,
 * e.g. `2024-01-15T10:30:00.000Z`).
 *
 * Old clients that saved a bare-date `nextCursor` from before this change
 * will keep working: we detect that the value isn't a base64url-encoded
 * JSON object and treat it as `{ createdAt, id: undefined }`. Without an id
 * there is no way to disambiguate rows that share the same `createdAt`, so
 * that single page may still skip/repeat ties — this is an intentional,
 * one-page-only tradeoff to avoid breaking old clients outright. Every
 * `nextCursor` we hand back from here on is the new composite format, so
 * the client self-heals on the very next request.
 *
 * Throws `InvalidCursorError` for cursors that are neither a valid
 * composite token nor a valid ISO date string; callers should turn this
 * into a clean 400 response rather than letting it crash the request.
 */
export function decodeCursor(raw: string): CompositeCursor {
  let composite: { createdAt: string; id?: unknown } | undefined;

  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>).createdAt === 'string'
    ) {
      composite = parsed as { createdAt: string; id?: unknown };
    }
  } catch {
    // Not a valid composite token — fall through to legacy handling below.
  }

  if (composite) {
    if (Number.isNaN(new Date(composite.createdAt).getTime())) {
      throw new InvalidCursorError('invalid cursor createdAt');
    }
    return {
      createdAt: composite.createdAt,
      id: typeof composite.id === 'string' ? composite.id : undefined,
    };
  }

  // Legacy format: a bare ISO date string, with no tie-breaker id available.
  const legacyDate = new Date(raw);
  if (!Number.isNaN(legacyDate.getTime())) {
    return { createdAt: legacyDate.toISOString(), id: undefined };
  }

  throw new InvalidCursorError('malformed cursor');
}
