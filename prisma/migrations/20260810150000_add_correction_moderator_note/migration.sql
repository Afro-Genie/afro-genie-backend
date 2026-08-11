-- Add moderatorNote to TranslationCorrection for the correction-request queue
-- Idempotent (guarded) so it is safe to re-run.

ALTER TABLE "TranslationCorrection" ADD COLUMN IF NOT EXISTS "moderatorNote" TEXT;
