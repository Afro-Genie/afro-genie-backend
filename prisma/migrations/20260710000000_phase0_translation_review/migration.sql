-- Phase 0 — Translation Review & Corrections
-- Purely additive review fields for Translation and TranslationCorrection.
-- Idempotent (guarded) so it is safe to re-run on already-migrated databases.

-- Add review columns to Translation
ALTER TABLE "Translation"
  ADD COLUMN IF NOT EXISTS "approvedById" TEXT,
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewedById" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;

-- Add review columns to TranslationCorrection
ALTER TABLE "TranslationCorrection"
  ADD COLUMN IF NOT EXISTS "reviewedById" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);

-- Indexes for the new review columns
CREATE INDEX IF NOT EXISTS "Translation_approvedById_idx" ON "Translation"("approvedById");
CREATE INDEX IF NOT EXISTS "Translation_reviewedById_idx" ON "Translation"("reviewedById");
CREATE INDEX IF NOT EXISTS "TranslationCorrection_reviewedById_idx" ON "TranslationCorrection"("reviewedById");

-- Foreign keys (idempotent via DO block)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Translation_approvedById_fkey') THEN
    ALTER TABLE "Translation" ADD CONSTRAINT "Translation_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Translation_reviewedById_fkey') THEN
    ALTER TABLE "Translation" ADD CONSTRAINT "Translation_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TranslationCorrection_reviewedById_fkey') THEN
    ALTER TABLE "TranslationCorrection" ADD CONSTRAINT "TranslationCorrection_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
