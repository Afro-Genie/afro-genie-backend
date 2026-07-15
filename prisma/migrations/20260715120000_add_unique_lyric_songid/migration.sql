-- Ensure no duplicate songId rows exist before adding unique constraint
-- Delete duplicate lyrics, keeping the one with the most content
DELETE FROM "Lyric" a
USING "Lyric" b
WHERE a."songId" = b."songId"
  AND a."id" > b."id"
  AND (a."content" IS NULL OR length(a."content") < length(b."content"));

-- Add unique constraint on songId for idempotent upserts
CREATE UNIQUE INDEX "Lyric_songId_key" ON "Lyric"("songId");
