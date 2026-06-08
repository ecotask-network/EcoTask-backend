-- Add user profile fields
ALTER TABLE "User" ADD COLUMN "name" TEXT;
ALTER TABLE "User" ADD COLUMN "bio" TEXT;
ALTER TABLE "User" ADD COLUMN "avatar_url" TEXT;
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';
