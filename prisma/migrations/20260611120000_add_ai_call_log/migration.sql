CREATE TABLE IF NOT EXISTS "AICallLog" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "tokensInput" INTEGER NOT NULL,
  "tokensOutput" INTEGER NOT NULL,
  "estimatedCostUsd" DOUBLE PRECISION NOT NULL,
  "songId" TEXT,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AICallLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AICallLog_provider_idx" ON "AICallLog"("provider");
CREATE INDEX IF NOT EXISTS "AICallLog_songId_idx" ON "AICallLog"("songId");
CREATE INDEX IF NOT EXISTS "AICallLog_userId_idx" ON "AICallLog"("userId");
CREATE INDEX IF NOT EXISTS "AICallLog_createdAt_idx" ON "AICallLog"("createdAt");
