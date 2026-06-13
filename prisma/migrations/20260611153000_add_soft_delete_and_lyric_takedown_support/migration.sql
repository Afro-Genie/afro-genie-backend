ALTER TABLE "Artist"
  ADD COLUMN IF NOT EXISTS "softDeleted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Song"
  ADD COLUMN IF NOT EXISTS "softDeleted" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Lyric"
  ALTER COLUMN "content" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "Artist_softDeleted_idx" ON "Artist"("softDeleted");
CREATE INDEX IF NOT EXISTS "Song_softDeleted_idx" ON "Song"("softDeleted");
