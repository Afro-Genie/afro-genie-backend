CREATE TYPE "GameType" AS ENUM ('LYRIC_GENIE', 'STAR_SEEKER', 'RHYTHM_GROUPS', 'DAILY_BEADS');
CREATE TYPE "GamePuzzleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "GamePlayStatus" AS ENUM ('IN_PROGRESS', 'WON', 'LOST', 'COMPLETED');

CREATE TABLE "GamePuzzle" (
  "id" TEXT NOT NULL,
  "game" "GameType" NOT NULL,
  "level" INTEGER NOT NULL,
  "status" "GamePuzzleStatus" NOT NULL DEFAULT 'DRAFT',
  "content" JSONB NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GamePuzzle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GamePlay" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "guestTokenHash" CHAR(64),
  "game" "GameType" NOT NULL,
  "puzzleId" TEXT NOT NULL,
  "puzzleDate" DATE NOT NULL,
  "status" "GamePlayStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "state" JSONB NOT NULL,
  "actionResults" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "version" INTEGER NOT NULL DEFAULT 0,
  "won" BOOLEAN,
  "score" INTEGER,
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GamePlay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GamePlay_exactly_one_owner_check" CHECK (
    ("userId" IS NOT NULL AND "guestTokenHash" IS NULL)
    OR ("userId" IS NULL AND "guestTokenHash" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "GamePuzzle_game_level_key" ON "GamePuzzle"("game", "level");
CREATE INDEX "GamePuzzle_game_status_level_idx" ON "GamePuzzle"("game", "status", "level");

CREATE UNIQUE INDEX "GamePlay_userId_game_puzzleDate_key"
  ON "GamePlay"("userId", "game", "puzzleDate");
CREATE UNIQUE INDEX "GamePlay_guestTokenHash_game_puzzleDate_key"
  ON "GamePlay"("guestTokenHash", "game", "puzzleDate");
CREATE INDEX "GamePlay_userId_puzzleDate_idx" ON "GamePlay"("userId", "puzzleDate");
CREATE INDEX "GamePlay_game_puzzleDate_idx" ON "GamePlay"("game", "puzzleDate");
CREATE INDEX "GamePlay_expiresAt_idx" ON "GamePlay"("expiresAt");

ALTER TABLE "GamePlay"
  ADD CONSTRAINT "GamePlay_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GamePlay"
  ADD CONSTRAINT "GamePlay_puzzleId_fkey"
  FOREIGN KEY ("puzzleId") REFERENCES "GamePuzzle"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
