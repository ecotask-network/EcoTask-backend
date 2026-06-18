-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('PENDING', 'VERIFYING', 'APPROVED', 'REJECTED');

-- CreateTable User
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "name" TEXT,
    "bio" TEXT,
    "avatar_url" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable tasks
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "reward_amount" DOUBLE PRECISION NOT NULL,
    "reward_token" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radius_meters" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable proofs
CREATE TABLE "proofs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "status" "ProofStatus" NOT NULL DEFAULT 'PENDING',
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable proof_photos
CREATE TABLE "proof_photos" (
    "id" TEXT NOT NULL,
    "proof_id" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "filename" TEXT NOT NULL,

    CONSTRAINT "proof_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable verifications
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "proof_id" TEXT NOT NULL,
    "verifier_id" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_wallet_key" ON "User"("wallet");

-- AddForeignKey
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proofs" ADD CONSTRAINT "proofs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proof_photos" ADD CONSTRAINT "proof_photos_proof_id_fkey" FOREIGN KEY ("proof_id") REFERENCES "proofs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_proof_id_fkey" FOREIGN KEY ("proof_id") REFERENCES "proofs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
