CREATE TABLE IF NOT EXISTS "AfricanMusicChannel" (
  "id" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "artistName" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "genres" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evidenceUrl" TEXT,
  "approved" BOOLEAN NOT NULL DEFAULT true,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AfricanMusicChannel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AfricanMusicChannel_channelId_key"
  ON "AfricanMusicChannel"("channelId");
CREATE INDEX IF NOT EXISTS "AfricanMusicChannel_artistName_idx"
  ON "AfricanMusicChannel"("artistName");
CREATE INDEX IF NOT EXISTS "AfricanMusicChannel_approved_idx"
  ON "AfricanMusicChannel"("approved");
