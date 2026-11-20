DROP INDEX IF EXISTS "Song_title_artistId_key";

CREATE UNIQUE INDEX "Song_title_artistId_key"
ON "Song"("title", "artistId")
WHERE "softDeleted" = false;
