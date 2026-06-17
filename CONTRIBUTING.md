# Contributing to EcoTask Backend

## Prerequisites
- Node.js 20+
- PostgreSQL 15+
- Redis 7+

## Setup
1. `cp .env.example .env`
2. `npm install`
3. `npx prisma migrate dev`
4. `npm run dev`

## Testing
```bash
npm test
npm run test:coverage
npm run test:integration
```

## API Docs
Run the server and visit `/api/docs` for Swagger UI.
