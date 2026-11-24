-- AlterTable
ALTER TABLE "Song" ADD COLUMN IF NOT EXISTS "lyricsBackfillMissedAt" TIMESTAMP(3);
