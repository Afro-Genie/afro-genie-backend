-- Track source/target languages on human translation requests
ALTER TABLE "TranslationRequest"
  ADD COLUMN IF NOT EXISTS "sourceLang" TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS "targetLang" TEXT NOT NULL DEFAULT 'en';