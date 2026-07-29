-- Phase 6: Feature Expansion
-- Token redemption store, referral rewards, seasonal leaderboard, new badge types

-- Add new badge types to the BadgeType enum
ALTER TYPE "BadgeType" ADD VALUE 'DAILY_STREAK_7';
ALTER TYPE "BadgeType" ADD VALUE 'FIRST_PROFILE';
ALTER TYPE "BadgeType" ADD VALUE 'GENEROUS_SUPPORTER';
ALTER TYPE "BadgeType" ADD VALUE 'SEASON_CHAMPION';
ALTER TYPE "BadgeType" ADD VALUE 'REFERRAL_STAR';

-- Add referral fields to User
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "User" ADD COLUMN "referredByUserId" TEXT;

-- Create unique index on referralCode (nullable, PostgreSQL allows multiple NULLs)
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode") WHERE "referralCode" IS NOT NULL;

-- Add foreign key for referredByUserId
ALTER TABLE "User" ADD CONSTRAINT "User_referredByUserId_fkey" FOREIGN KEY ("referredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Create index on referredByUserId
CREATE INDEX "User_referredByUserId_idx" ON "User"("referredByUserId");

-- Create StoreItem table
CREATE TABLE "StoreItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tokenCost" INTEGER NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'cosmetic',
    "metadata" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreItem_pkey" PRIMARY KEY ("id")
);

-- Create StorePurchase table
CREATE TABLE "StorePurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "spentAmount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorePurchase_pkey" PRIMARY KEY ("id")
);

-- Add foreign keys and indexes for StorePurchase
ALTER TABLE "StorePurchase" ADD CONSTRAINT "StorePurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StorePurchase" ADD CONSTRAINT "StorePurchase_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StoreItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "StorePurchase_userId_idx" ON "StorePurchase"("userId");
CREATE INDEX "StorePurchase_itemId_idx" ON "StorePurchase"("itemId");
CREATE INDEX "StorePurchase_createdAt_idx" ON "StorePurchase"("createdAt");
CREATE UNIQUE INDEX "StorePurchase_userId_itemId_createdAt_key" ON "StorePurchase"("userId", "itemId", "createdAt");

-- Create LeaderboardSnapshot table
CREATE TABLE "LeaderboardSnapshot" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderboardSnapshot_pkey" PRIMARY KEY ("id")
);

-- Add indexes for LeaderboardSnapshot
CREATE INDEX "LeaderboardSnapshot_period_idx" ON "LeaderboardSnapshot"("period");
CREATE INDEX "LeaderboardSnapshot_startDate_idx" ON "LeaderboardSnapshot"("startDate");
CREATE UNIQUE INDEX "LeaderboardSnapshot_period_startDate_key" ON "LeaderboardSnapshot"("period", "startDate");
