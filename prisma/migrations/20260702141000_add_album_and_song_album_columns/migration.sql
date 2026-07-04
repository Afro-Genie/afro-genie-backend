CREATE TABLE IF NOT EXISTS "Album" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "artistId" TEXT NOT NULL,
  "imageUrl" TEXT,
  "spotifyId" TEXT,
  "releaseYear" INTEGER,
  "totalTracks" INTEGER,
  "popularity" INTEGER NOT NULL DEFAULT 0,
  "genres" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Album_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Song"
  ADD COLUMN IF NOT EXISTS "albumId" TEXT,
  ADD COLUMN IF NOT EXISTS "durationMs" INTEGER,
  ADD COLUMN IF NOT EXISTS "trackNumber" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "Album_spotifyId_key" ON "Album"("spotifyId");
CREATE INDEX IF NOT EXISTS "Album_artistId_idx" ON "Album"("artistId");
CREATE INDEX IF NOT EXISTS "Album_releaseYear_idx" ON "Album"("releaseYear");
CREATE INDEX IF NOT EXISTS "Song_albumId_idx" ON "Song"("albumId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Album_artistId_fkey'
  ) THEN
    ALTER TABLE "Album"
      ADD CONSTRAINT "Album_artistId_fkey"
      FOREIGN KEY ("artistId") REFERENCES "Artist"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Song_albumId_fkey'
  ) THEN
    ALTER TABLE "Song"
      ADD CONSTRAINT "Song_albumId_fkey"
      FOREIGN KEY ("albumId") REFERENCES "Album"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END
$$;
