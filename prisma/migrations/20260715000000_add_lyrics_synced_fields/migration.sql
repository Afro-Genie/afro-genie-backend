-- AlterEnum: Add LRCLIB to LyricSourceProvider
ALTER TYPE "LyricSourceProvider" ADD VALUE 'LRCLIB';

-- AlterTable: Add syncedLyrics and lyricLines to Lyric
ALTER TABLE "Lyric" ADD COLUMN "syncedLyrics" TEXT;
ALTER TABLE "Lyric" ADD COLUMN "lyricLines" JSONB;
