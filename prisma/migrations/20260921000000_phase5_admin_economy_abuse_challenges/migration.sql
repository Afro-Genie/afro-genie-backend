-- CreateEnum
CREATE TYPE "ChallengeType" AS ENUM ('TRANSLATE_N_SONGS', 'EARN_N_GT', 'ACHIEVE_N_APPROVALS', 'STREAK_7_DAYS', 'INVITE_3_FRIENDS');

-- CreateTable
CREATE TABLE "EconomyConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "lastModifiedBy" TEXT,
    "lastModifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbuseFlag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "reason" TEXT,
    "metadata" JSONB,
    "pausedRewards" BOOLEAN NOT NULL DEFAULT false,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbuseFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Challenge" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "ChallengeType" NOT NULL,
    "targetValue" INTEGER NOT NULL,
    "gtReward" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EconomyConfig_key_key" ON "EconomyConfig"("key");

-- CreateIndex
CREATE INDEX "EconomyConfig_lastModifiedAt_idx" ON "EconomyConfig"("lastModifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AbuseFlag_userId_rule_key" ON "AbuseFlag"("userId", "rule");

-- CreateIndex
CREATE INDEX "AbuseFlag_rule_idx" ON "AbuseFlag"("rule");

-- CreateIndex
CREATE INDEX "AbuseFlag_pausedRewards_reviewed_idx" ON "AbuseFlag"("pausedRewards", "reviewed");

-- CreateIndex
CREATE INDEX "AbuseFlag_createdAt_idx" ON "AbuseFlag"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Challenge_type_startsAt_key" ON "Challenge"("type", "startsAt");

-- CreateIndex
CREATE INDEX "Challenge_active_expiresAt_idx" ON "Challenge"("active", "expiresAt");

-- AddForeignKey
ALTER TABLE "AbuseFlag" ADD CONSTRAINT "AbuseFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;