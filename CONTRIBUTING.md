# Contributing to EcoTask Backend

First off, thank you for considering contributing! We welcome contributions
from everyone — whether it's a bug report, a feature suggestion, a PR, or
helping another contributor.

## Code of Conduct

This project adheres to the [Contributor Covenant](CODE_OF_CONDUCT.md).
By participating, you are expected to uphold this code.

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Redis 7+

### Local Setup

```bash
cp .env.example .env        # configure your environment
npm install                  # install dependencies
npx prisma migrate dev       # run database migrations
npm run dev                  # start the dev server on :3000
```

### Docker Setup

```bash
docker-compose up --build
```

## Development Workflow

1. **Pick an issue** — comment on it so others know you're working on it.
2. **Fork & branch** — create a feature branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
   Use a clear prefix: `feat/`, `fix/`, `refactor/`, `test/`, `docs/`, `chore/`.
3. **Write code** — follow the [coding conventions](#coding-conventions) below.
4. **Add tests** — cover new functionality in `tests/`.
5. **Run checks** locally before pushing:
   ```bash
   npm run lint        # lint all source files
   npm run build       # ensure TypeScript compiles
   npm test            # run all tests
   ```
6. **Open a PR** — use the pull request template and link the related issue.

## Coding Conventions

- **Language:** TypeScript with strict mode enabled.
- **Imports:** Use ES module syntax with `.js` extensions (e.g. `import foo from "./bar.js"`).
- **Formatting:** 2-space indentation, single quotes, semicolons. An `.editorconfig`
  file is included for editor settings.
- **Naming:**
  - `camelCase` for variables, functions, and methods
  - `PascalCase` for classes, types, and interfaces
  - `kebab-case` for file names
  - Prefix unused parameters with `_` (e.g. `_req`, `_res`)
- **Error handling:** Use the global `errorHandler` middleware; throw or pass errors
  to `next()`.
- **Validation:** Use [Zod](https://zod.dev) schemas for request body validation.
- **Database:** Use Prisma for all queries; avoid raw SQL.
- **No comments in code** unless the "why" is non-obvious. Let the code speak.

## Project Structure

```
src/
├── routes/        # Express route definitions (thin — delegate to controllers)
├── controllers/   # Request/response handling
├── services/      # Business logic
├── middleware/     # Express middleware (auth, rate-limit, upload, error handler)
├── workers/       # BullMQ background job processors
├── models/        # Prisma model helpers / types
├── utils/         # Shared utilities (logger, helpers)
├── types/         # Ambient type declarations
└── app.ts         # Express app entry point
```

## Testing

```bash
npm test                    # run all tests
npm run test:coverage       # run with coverage report
npm run test:integration    # integration tests only
npm run test:e2e            # end-to-end tests only
```

We use **Jest** + **Supertest**. Tests live in `tests/` mirroring `src/` structure.
New features should include unit and/or integration tests.

## Linting

We use ESLint with the TypeScript parser:

```bash
npm run lint
```

## Commit Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add proof geolocation validation
fix: handle expired JWT tokens gracefully
refactor: extract stellar signing to a helper
test: add verification worker unit tests
docs: update API endpoint list in README
chore: bump express to 4.19
```

This keeps the git log clean and enables automated changelog generation.

## Pull Request Process

1. Ensure all CI checks pass (build, lint, test).
2. Update documentation if public APIs change.
3. Squash commits into a meaningful message before merge.
4. A maintainer will review; expect constructive feedback.

## Questions?

Open a [discussion](https://github.com/ecotask-network/EcoTask-backend/discussions)
or ask in the issue you're working on.
