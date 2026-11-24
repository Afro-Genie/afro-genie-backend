-- Artist translation analytics + badge store support

ALTER TABLE "ArtistAnalyticsDaily"
  ADD COLUMN IF NOT EXISTS "translationReaders" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "returningReaders" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "translationRequests" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "translationRequestsFulfilled" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lyricsViews" INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'FIRST_TRANSLATION_UNLOCK';
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'BRIDGE_BUILDER';
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'LANGUAGE_PIONEER';
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'CONTEXT_CURATOR';
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'COMMUNITY_TRUSTED';
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'CORRECTION_CHAMPION';
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'GLOBAL_LISTENER_REACH';
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'MOST_REQUESTED';
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'CATALOG_CLARITY';
  ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'CULTURAL_MILESTONE';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "TranslationViewEvent" (
  "id" TEXT NOT NULL,
  "songId" TEXT NOT NULL,
  "translationId" TEXT,
  "artistId" TEXT NOT NULL,
  "userId" TEXT,
  "sessionId" TEXT,
  "targetLang" TEXT NOT NULL,
  "country" TEXT,
  "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TranslationViewEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TranslationViewEvent_artistId_viewedAt_idx" ON "TranslationViewEvent"("artistId", "viewedAt");
CREATE INDEX IF NOT EXISTS "TranslationViewEvent_songId_viewedAt_idx" ON "TranslationViewEvent"("songId", "viewedAt");
CREATE INDEX IF NOT EXISTS "TranslationViewEvent_targetLang_idx" ON "TranslationViewEvent"("targetLang");
CREATE INDEX IF NOT EXISTS "TranslationViewEvent_country_idx" ON "TranslationViewEvent"("country");
CREATE INDEX IF NOT EXISTS "TranslationViewEvent_userId_viewedAt_idx" ON "TranslationViewEvent"("userId", "viewedAt");
CREATE INDEX IF NOT EXISTS "TranslationViewEvent_sessionId_viewedAt_idx" ON "TranslationViewEvent"("sessionId", "viewedAt");

DO $$ BEGIN
  ALTER TABLE "TranslationViewEvent" ADD CONSTRAINT "TranslationViewEvent_songId_fkey" FOREIGN KEY ("songId") REFERENCES "Song"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "TranslationViewEvent" ADD CONSTRAINT "TranslationViewEvent_translationId_fkey" FOREIGN KEY ("translationId") REFERENCES "Translation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "TranslationViewEvent" ADD CONSTRAINT "TranslationViewEvent_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "TranslationViewEvent" ADD CONSTRAINT "TranslationViewEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
