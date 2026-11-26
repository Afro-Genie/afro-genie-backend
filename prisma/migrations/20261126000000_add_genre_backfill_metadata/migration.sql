-- AlterTable
ALTER TABLE "Artist" ADD COLUMN IF NOT EXISTS "musicBrainzId" TEXT;
ALTER TABLE "Artist" ADD COLUMN IF NOT EXISTS "genreBackfillMissedAt" TIMESTAMP(3);
ALTER TABLE "Artist" ADD COLUMN IF NOT EXISTS "genreBackfillAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Song" ADD COLUMN IF NOT EXISTS "musicBrainzId" TEXT;
ALTER TABLE "Song" ADD COLUMN IF NOT EXISTS "genreBackfillMissedAt" TIMESTAMP(3);
ALTER TABLE "Song" ADD COLUMN IF NOT EXISTS "genreBackfillAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Artist_musicBrainzId_key" ON "Artist"("musicBrainzId");
CREATE INDEX IF NOT EXISTS "Artist_genreBackfillMissedAt_idx" ON "Artist"("genreBackfillMissedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Song_musicBrainzId_key" ON "Song"("musicBrainzId");
CREATE INDEX IF NOT EXISTS "Song_genreBackfillMissedAt_idx" ON "Song"("genreBackfillMissedAt");
