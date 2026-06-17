<div align="center">

# ⚙️ ecotask-backend

**The EcoTask API server — proof verification, task management, and Stellar oracle.**

*A Node.js/Express backend that bridges the real world and the blockchain — processing proof submissions, coordinating validators, and triggering on-chain rewards.*

[![Build](https://img.shields.io/badge/Build-Passing-brightgreen)]()
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4.18-000000?logo=express)](https://expressjs.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-336791?logo=postgresql)](https://postgresql.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Status](https://img.shields.io/badge/Status-v0.1.0--alpha-blue)]()

</div>

---

## 🌍 Overview

`ecotask-backend` is the off-chain infrastructure layer of EcoTask. It acts as the trusted bridge between user actions in the mobile app and the Stellar smart contracts that release rewards.

The backend is responsible for:

- 🗂️ **Task management** — Creating, listing, and expiring tasks
- 📸 **Proof intake** — Receiving photo + GPS submissions from the mobile app
- 🔍 **Verification coordination** — Routing proofs to community validators or automated checks
- ⛓️ **Stellar oracle** — Submitting verified results to the `reward-engine` smart contract
- 📊 **Analytics** — Tracking impact metrics (trees planted, plastic collected, CO₂ offset)
- 🔔 **Notifications** — Alerting users when their proof is verified and reward is sent

---

## ✨ Key Responsibilities

| Module | What It Does |
|--------|-------------|
| 🗂️ **Task API** | CRUD for tasks; filter by location, type, reward, status |
| 📤 **Proof API** | Accept photo uploads, extract GPS metadata, pin to IPFS |
| 🔍 **Verification Engine** | Queue-based system routing proofs to validators |
| ⛓️ **Stellar Oracle** | Signs and submits reward transactions to Soroban contracts |
| 👤 **User API** | Profile, wallet linking, impact history |
| 📊 **Analytics API** | Aggregated platform & user impact statistics |
| 🔐 **Auth** | JWT-based auth with Stellar wallet signature verification |

---

## 🏗️ Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node.js 20 | Fast, async-first, huge ecosystem |
| Framework | Express 4 | Lightweight, flexible REST APIs |
| Database | PostgreSQL 15 | Reliable relational data for tasks & users |
| ORM | Prisma | Type-safe DB queries with easy migrations |
| Queue | BullMQ + Redis | Async proof verification job queue |
| File Storage | IPFS (via Web3.Storage) | Decentralised, permanent proof storage |
| Blockchain | Stellar SDK (JS) | Submit transactions to reward-engine contract |
| Auth | JWT + Stellar keypair | Wallet-based authentication |
| Validation | Zod | Runtime schema validation |
| Testing | Jest + Supertest | Unit & integration tests |
| Docs | Swagger / OpenAPI | Auto-generated API documentation |

---

## 📁 Folder Structure

```
ecotask-backend/
├── src/
│   ├── routes/                   # Express route definitions
│   │   ├── tasks.ts                  # GET/POST /tasks
│   │   ├── proofs.ts                 # POST /proofs
│   │   ├── users.ts                  # GET/PUT /users
│   │   ├── auth.ts                   # POST /auth/login, /auth/verify
│   │   └── analytics.ts              # GET /analytics
│   │
│   ├── controllers/              # Route handler logic
│   │   ├── taskController.ts
│   │   ├── proofController.ts
│   │   ├── userController.ts
│   │   ├── authController.ts
│   │   └── analyticsController.ts
│   │
│   ├── services/                 # Core business logic
│   │   ├── verificationService.ts    # Proof review & scoring
│   │   ├── stellarService.ts         # Stellar SDK + oracle calls
│   │   ├── ipfsService.ts            # Upload proofs to IPFS
│   │   ├── notificationService.ts    # Push notification dispatch
│   │   └── geoService.ts             # Location validation & distance
│   │
│   ├── middleware/               # Express middleware
│   │   ├── auth.ts                   # JWT verification
│   │   ├── rateLimit.ts              # Request throttling
│   │   ├── upload.ts                 # Multer file upload config
│   │   └── errorHandler.ts           # Global error handling
│   │
│   ├── models/                   # Prisma schema types & helpers
│   │   ├── task.ts
│   │   ├── proof.ts
│   │   └── user.ts
│   │
│   ├── workers/                  # BullMQ background jobs
│   │   ├── verificationWorker.ts     # Process proof verification queue
│   │   └── rewardWorker.ts           # Trigger Stellar reward payouts
│   │
│   ├── utils/                    # Shared helpers
│   │   ├── logger.ts                 # Structured logging
│   │   ├── stellarUtils.ts           # Key formatting & signing helpers
│   │   └── ipfsUtils.ts              # CID formatting & gateway URLs
│   │
│   └── app.ts                    # Express app setup
│
├── prisma/
│   ├── schema.prisma             # Database schema
│   └── migrations/               # DB migration history
│
├── tests/
│   ├── routes/                   # Route integration tests
│   └── services/                 # Service unit tests
│
├── config/
│   ├── default.ts                # Default config values
│   └── production.ts             # Production overrides
│
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js >= 20
- PostgreSQL 15
- Redis (for BullMQ job queue)
- A Stellar testnet account (funded via [Friendbot](https://laboratory.stellar.org/#account-creator))

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/ecotask-network/ecotask-backend.git
cd ecotask-backend

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env
# Fill in your database URL, Stellar keys, IPFS token, etc.

# 4. Run database migrations
npx prisma migrate dev

# 5. Seed the database with sample tasks
npm run db:seed

# 6. Start the development server
npm run dev
```

### Or with Docker

```bash
docker-compose up --build
# API available at http://localhost:3000
```

### Environment Variables

```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/ecotask

# Redis
REDIS_URL=redis://localhost:6379

# Stellar
STELLAR_NETWORK=testnet
STELLAR_ORACLE_SECRET_KEY=YOUR_ORACLE_SECRET_KEY
REWARD_ENGINE_CONTRACT_ID=YOUR_CONTRACT_ID

# IPFS
WEB3_STORAGE_TOKEN=YOUR_WEB3_STORAGE_TOKEN

# Auth
JWT_SECRET=your_jwt_secret_here
JWT_EXPIRES_IN=7d
```

---

## 📡 API Overview

Full docs available at `/api/docs` (Swagger UI) when running locally.

### Tasks
```
GET    /api/tasks              # List tasks (filter by type, location, status)
GET    /api/tasks/:id          # Get single task details
POST   /api/tasks              # Create a task (admin/sponsor only)
PUT    /api/tasks/:id          # Update task (admin only)
DELETE /api/tasks/:id          # Delete/expire a task
```

### Proofs
```
POST   /api/proofs             # Submit proof (photo + GPS + task_id)
GET    /api/proofs/:id         # Get proof status
GET    /api/proofs/user/:id    # Get all proofs by a user
```

### Users
```
POST   /api/auth/login         # Authenticate with Stellar wallet signature
GET    /api/users/:id          # Get user profile & stats
PUT    /api/users/:id          # Update profile
GET    /api/users/:id/impact   # Get impact history (trees, plastic, CO₂)
```

### Analytics
```
GET    /api/analytics/platform  # Global platform impact stats
GET    /api/analytics/leaderboard # Top contributors
```

---

## 🔍 Verification Flow

```
User submits proof
       │
       ▼
Proof saved to DB (status: pending)
       │
       ▼
Photo + GPS pinned to IPFS
       │
       ▼
Job added to BullMQ verification queue
       │
       ▼
verificationWorker picks up job
       │
       ├── Auto-checks (GPS in task zone? Photo contains relevant content?)
       │
       └── Community validator review (if auto-check inconclusive)
              │
              ▼
       Proof approved / rejected
              │
       ┌──────┴──────┐
       ▼             ▼
   Rejected       Approved
   (notify)          │
                     ▼
            rewardWorker triggers
            Stellar oracle call
                     │
                     ▼
            ECO tokens / USDC sent
            to user's Stellar wallet
                     │
                     ▼
            User notified ✅
```

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Run integration tests only
npm run test:integration
```

---

## 🤝 Contributing

Backend developers, DevOps engineers, and database architects especially welcome!
See [CONTRIBUTING.md](./CONTRIBUTING.md) to get started.

---

## 📄 License

MIT — see [LICENSE](./LICENSE) for details.

---

## Ecosystem

This is part of the [EcoTask Network](https://github.com/ecotask-network):

| Repo | Description |
|------|-------------|
| [EcoTask-app](https://github.com/ecotask-network/EcoTask-app) | Mobile dApp |
| [EcoTask-backend](https://github.com/ecotask-network/EcoTask-backend) | Node.js API & verification engine |
| [EcoTask-contracts](https://github.com/ecotask-network/EcoTask-contract) | Stellar Soroban smart contracts |
| [EcoTask-docs](https://github.com/ecotask-network/EcoTask-docs) | Documentation hub |

---

<div align="center">

*Part of the [EcoTask Network](https://github.com/ecotask-network) — Because the environment deserves an economy.*

</div>
