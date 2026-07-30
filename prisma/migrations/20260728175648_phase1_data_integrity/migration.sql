-- Phase 1: Data Integrity Fixes
-- Unique constraints for badge dedup, idempotencyKey for at-most-once rewards

-- Add unique constraint on UserBadge(userId, badgeType) to prevent duplicate badges
-- If existing duplicate rows exist, this migration will fail — clean them first
DELETE FROM "UserBadge"
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY "userId", "badgeType" ORDER BY "earnedAt" ASC) AS rn
    FROM "UserBadge"
  ) sub WHERE rn > 1
);

CREATE UNIQUE INDEX "UserBadge_userId_badgeType_key" ON "UserBadge"("userId", "badgeType");

-- Add idempotencyKey column to TokenReward for entity-level deduplication
ALTER TABLE "TokenReward" ADD COLUMN "idempotencyKey" TEXT;

-- Clean any null idempotencyKey entries before creating unique index (nulls allowed in unique index in PG)
CREATE UNIQUE INDEX "TokenReward_idempotencyKey_key" ON "TokenReward"("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;

-- Add index on reason for admin stats groupBy queries
CREATE INDEX "TokenReward_reason_idx" ON "TokenReward"("reason");
