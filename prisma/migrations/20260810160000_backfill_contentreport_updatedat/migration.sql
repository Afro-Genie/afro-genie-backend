-- Backfill a pre-existing ContentReport table that was missing updatedAt.
-- Idempotent (guarded) so it is safe to re-run.

ALTER TABLE "ContentReport" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
