-- Soft-delete support for community topics
ALTER TABLE "Topic"
  ADD COLUMN IF NOT EXISTS "softDeleted" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Topic_softDeleted_idx" ON "Topic"("softDeleted");

-- Backfill: topics previously soft-deleted via title/content wipe are now flagged
UPDATE "Topic"
SET "softDeleted" = true
WHERE "softDeleted" = false
  AND ("title" = '[deleted]' OR "content" = '[deleted]');