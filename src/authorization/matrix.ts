/**
 * Central, declarative authorization map — the single source of truth for
 * which access level each API route requires.
 *
 * Every entry in `ROUTE_ACCESS_MATRIX` is exercised by the enforcement test in
 * `tests/authorization/matrix.test.ts`, which issues real supertest requests
 * and asserts the exact status code for each role (anonymous, user, other
 * user, validator, admin) plus a token issued for a deleted user. If a route's
 * runtime behaviour drifts from the matrix below, that test fails.
 *
 * The matrix is documentation AND enforcement: keep it in sync with
 * `src/routes/*.ts` and `src/middleware/*.ts`.
 */

export type AccessLevel =
  | 'public'
  | 'authenticated'
  | 'owner'
  | 'owner-or-admin'
  | 'validator-or-admin'
  | 'admin';

export interface RouteAccess {
  /** HTTP method as registered on the router. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Route pattern (params shown as `:name`). */
  path: string;
  /** Minimum access required to reach the handler. */
  access: AccessLevel;
  /**
   * Optional notes clarifying edge cases (e.g. ownership enforced as 404 to
   * avoid resource enumeration).
   */
  notes?: string;
}

/**
 * `access` semantics per role:
 *
 * | access              | anonymous | user (owner) | user (other) | validator | admin |
 * |---------------------|-----------|--------------|--------------|-----------|-------|
 * | public              | 2xx       | 2xx          | 2xx          | 2xx       | 2xx   |
 * | authenticated       | 401       | 2xx          | 2xx          | 2xx       | 2xx   |
 * | owner               | 401       | 2xx          | 403/404      | 403/404   | 403/404 |
 * | owner-or-admin      | 401       | 2xx          | 403          | 403       | 2xx   |
 * | validator-or-admin  | 401       | 403          | 403          | 2xx       | 2xx   |
 * | admin               | 401       | 403          | 403          | 403       | 2xx   |
 *
 * Where ownership applies, "user (owner)" means the authenticated user's id
 * matches the resource in the path; "user (other)" means it does not.
 */
export const ROUTE_ACCESS_MATRIX: RouteAccess[] = [
  // Health
  { method: 'GET', path: '/', access: 'public', notes: 'service root banner' },
  { method: 'GET', path: '/health', access: 'public', notes: 'liveness + dependency checks' },

  // Auth
  {
    method: 'GET',
    path: '/auth/challenge',
    access: 'public',
    notes: 'Stellar sign-in challenge request',
  },
  { method: 'POST', path: '/auth/login', access: 'public' },
  {
    method: 'POST',
    path: '/auth/logout',
    access: 'public',
    notes: 'self-service token revocation; controller requires a Bearer token and returns 401 without one (not an authz gate)',
  },
  { method: 'POST', path: '/auth/verify', access: 'authenticated' },

  // Users
  { method: 'GET', path: '/users/me', access: 'authenticated' },
  {
    method: 'GET',
    path: '/users/:id',
    access: 'authenticated',
    notes: 'profile visibility decision: authenticated-only (anonymous enumeration removed)',
  },
  { method: 'PUT', path: '/users/:id', access: 'owner' },
  { method: 'GET', path: '/users/:id/impact', access: 'owner' },

  // Tasks
  { method: 'GET', path: '/tasks', access: 'public' },
  { method: 'GET', path: '/tasks/:id', access: 'public' },
  { method: 'POST', path: '/tasks', access: 'admin' },
  { method: 'PUT', path: '/tasks/:id', access: 'admin' },
  { method: 'DELETE', path: '/tasks/:id', access: 'admin' },

  // Task claims
  { method: 'POST', path: '/tasks/:id/claim', access: 'authenticated' },
  { method: 'DELETE', path: '/tasks/:id/claim', access: 'authenticated' },
  { method: 'GET', path: '/tasks/:id/claims', access: 'authenticated' },

  // Proofs
  { method: 'POST', path: '/proofs', access: 'authenticated' },
  { method: 'GET', path: '/proofs/review', access: 'admin' },
  { method: 'POST', path: '/proofs/:id/review', access: 'admin' },
  {
    method: 'GET',
    path: '/proofs/:id',
    access: 'owner-or-admin',
    notes: 'ownership enforced in the controller (404-masked for non-owners via 403)',
  },
  { method: 'GET', path: '/proofs/user/:userId', access: 'owner-or-admin' },

  // Leaderboard / analytics
  { method: 'GET', path: '/leaderboard', access: 'public' },
  { method: 'GET', path: '/analytics/platform', access: 'public' },
  { method: 'GET', path: '/analytics/trends', access: 'public' },

  // Audit log (admin)
  { method: 'GET', path: '/audit', access: 'admin' },

  // Notifications
  { method: 'GET', path: '/notifications', access: 'authenticated' },
  { method: 'GET', path: '/notifications/unread-count', access: 'authenticated' },
  { method: 'POST', path: '/notifications/preferences', access: 'authenticated' },
  { method: 'POST', path: '/notifications/read-all', access: 'authenticated' },
  {
    method: 'POST',
    path: '/notifications/:id/read',
    access: 'owner',
    notes: 'non-owner responses are masked as 404 to avoid resource enumeration',
  },

  // Admin notifications
  { method: 'GET', path: '/admin/notifications/dead-letter', access: 'admin' },

  // Validators
  { method: 'GET', path: '/validators', access: 'admin' },
  { method: 'POST', path: '/validators/:userId/activate', access: 'admin' },
  { method: 'POST', path: '/validators/:userId/deactivate', access: 'admin' },
  { method: 'GET', path: '/validator/reviews', access: 'validator-or-admin' },
  { method: 'POST', path: '/validator/reviews/:proofId', access: 'validator-or-admin' },
];

/** Look up the access level for a given method + route pattern. */
export function getRouteAccess(
  method: string,
  path: string,
): AccessLevel | undefined {
  return ROUTE_ACCESS_MATRIX.find(
    (entry) => entry.method === method && entry.path === path,
  )?.access;
}