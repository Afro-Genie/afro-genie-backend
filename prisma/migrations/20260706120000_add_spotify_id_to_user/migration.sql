-- Add spotifyId column to User model
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "spotifyId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_spotifyId_key" ON "User"("spotifyId");
