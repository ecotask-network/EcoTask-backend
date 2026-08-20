# Authorization & Access Matrix

This document is the canonical description of **who can call which route**. The
same matrix is declared in code at `src/authorization/matrix.ts` and enforced by
the supertest suite in `tests/authorization/matrix.test.ts`, which walks the
matrix and asserts the exact HTTP status for every role — including a token
issued for a **deleted** user. If runtime behaviour ever drifts from this table,
the enforcement test fails.

## Roles

| Role        | Meaning                                                        |
|-------------|----------------------------------------------------------------|
| anonymous   | No `Authorization` header.                                     |
| user        | Authenticated, `role = "user"`.                                |
| validator   | Authenticated, `role = "validator"`.                           |
| admin       | Authenticated, `role = "admin"`.                               |
| deleted     | A token whose `userId` no longer exists in the database.       |

## Access levels

| Access             | anonymous | user (owner) | user (other) | validator | admin |
|--------------------|-----------|--------------|--------------|-----------|-------|
| public             | 2xx       | 2xx          | 2xx          | 2xx       | 2xx   |
| authenticated      | 401       | 2xx          | 2xx          | 2xx       | 2xx   |
| owner              | 401       | 2xx          | 403\*        | 403\*     | 403\* |
| owner-or-admin     | 401       | 2xx          | 403          | 403       | 2xx   |
| validator-or-admin | 401       | 403          | 403          | 2xx       | 2xx   |
| admin              | 401       | 403          | 403          | 403       | 2xx   |

\* Ownership is masked as **404** on `POST /notifications/:id/read` to avoid
resource enumeration; it is enforced as 403 elsewhere.

"user (owner)" = the authenticated user's id matches the resource in the path.
"user (other)" = the authenticated user's id does **not** match.

## Route matrix

| Method | Route                                    | Access             | Notes |
|--------|------------------------------------------|--------------------|-------|
| GET    | `/`                                      | public             | service banner |
| GET    | `/health`                                | public             | liveness + dependency checks |
| GET    | `/auth/challenge`                        | public             | Stellar sign-in challenge |
| POST   | `/auth/login`                            | public             | |
| POST   | `/auth/logout`                           | public             | self-service token revocation; controller requires a Bearer token and returns 401 without one (not an authz gate) |
| POST   | `/auth/verify`                           | authenticated      | |
| GET    | `/users/me`                              | authenticated      | |
| GET    | `/users/:id`                             | authenticated      | profile visibility decision: authenticated-only |
| PUT    | `/users/:id`                             | owner              | |
| GET    | `/users/:id/impact`                      | owner              | |
| GET    | `/tasks`                                 | public             | |
| GET    | `/tasks/:id`                             | public             | |
| POST   | `/tasks`                                 | admin              | |
| PUT    | `/tasks/:id`                             | admin              | |
| DELETE | `/tasks/:id`                             | admin              | |
| POST   | `/tasks/:id/claim`                       | authenticated      | |
| DELETE | `/tasks/:id/claim`                       | authenticated      | |
| GET    | `/tasks/:id/claims`                      | authenticated      | |
| POST   | `/proofs`                                | authenticated      | |
| GET    | `/proofs/review`                         | admin              | |
| POST   | `/proofs/:id/review`                     | admin              | |
| GET    | `/proofs/:id`                            | owner-or-admin     | ownership enforced in the controller (403 for others) |
| GET    | `/proofs/user/:userId`                   | owner-or-admin     | |
| GET    | `/leaderboard`                           | public             | |
| GET    | `/analytics/platform`                    | public             | |
| GET    | `/analytics/trends`                      | public             | |
| GET    | `/audit`                                 | admin              | |
| GET    | `/notifications`                         | authenticated      | |
| GET    | `/notifications/unread-count`            | authenticated      | |
| POST   | `/notifications/preferences`             | authenticated      | |
| POST   | `/notifications/read-all`                | authenticated      | |
| POST   | `/notifications/:id/read`                | owner              | non-owner masked as 404 |
| GET    | `/admin/notifications/dead-letter`       | admin              | |
| GET    | `/validators`                            | admin              | |
| POST   | `/validators/:userId/activate`           | admin              | |
| POST   | `/validators/:userId/deactivate`         | admin              | |
| GET    | `/validator/reviews`                     | validator-or-admin | |
| POST   | `/validator/reviews/:proofId`            | validator-or-admin | |

## Profile visibility decision

`GET /users/:id` is **authenticated-only**. Any signed-in user may read another
user's public profile, but an anonymous caller can no longer enumerate every
user's `wallet`, `name`, `bio`, `avatarUrl`, `role`, and `createdAt`. This keeps
profiles readable for the dApp while closing the anonymous enumeration gap.

## Deleted / demoted users

`authMiddleware` now resolves the caller's **current** user record from the
database on every authenticated request. As a result:

- A token for a **deleted** user returns `401 User no longer exists` on every
  authenticated route.
- A **demoted** user's token is immediately denied on
  `admin`/`validator-or-admin` routes, because role gates read the fresh role
  from `req.user.role` rather than the role baked into the (now stale) JWT.

`adminMiddleware` and `validatorMiddleware` read `req.user.role`, which is set
by `authMiddleware` — there is no second database lookup and no route silently
skips authorization by relying on another route's middleware ordering.