-- Token Economy Phase 2: Governance (Reports, Arbiter role, ModPool, Guidelines)
-- Idempotent (guarded) so it is safe to re-run on already-migrated databases.

-- Enums
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportStatus') THEN
    CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReportTargetType') THEN
    CREATE TYPE "ReportTargetType" AS ENUM ('TRANSLATION', 'TOPIC', 'COMMENT', 'USER', 'ARTIST', 'SONG');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ModerationAction') THEN
    CREATE TYPE "ModerationAction" AS ENUM ('TOPIC_PINNED', 'TOPIC_LOCKED', 'TOPIC_DELETED', 'COMMENT_DELETED', 'APPROVAL_OVERTURNED', 'POOL_DISTRIBUTION');
  END IF;
END $$;

-- Add ARBITER to UserRole (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ARBITER' AND enumtypid = '"UserRole"'::regtype) THEN
    ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ARBITER';
  END IF;
END $$;

-- ContentReport
CREATE TABLE IF NOT EXISTS "ContentReport" (
    "id" TEXT NOT NULL,
    "targetType" "ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "reporterId" TEXT NOT NULL,
    "moderatorId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ContentReport_status_idx" ON "ContentReport"("status");
CREATE INDEX IF NOT EXISTS "ContentReport_targetType_targetId_idx" ON "ContentReport"("targetType", "targetId");
CREATE INDEX IF NOT EXISTS "ContentReport_reporterId_idx" ON "ContentReport"("reporterId");
CREATE INDEX IF NOT EXISTS "ContentReport_moderatorId_idx" ON "ContentReport"("moderatorId");
CREATE INDEX IF NOT EXISTS "ContentReport_createdAt_idx" ON "ContentReport"("createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ContentReport_reporterId_fkey') THEN
    ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ContentReport_moderatorId_fkey') THEN
    ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ModPool
CREATE TABLE IF NOT EXISTS "ModPool" (
    "id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModPool_pkey" PRIMARY KEY ("id")
);

-- Guideline
CREATE TABLE IF NOT EXISTS "Guideline" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Guideline_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Guideline_updatedBy_idx" ON "Guideline"("updatedBy");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Guideline_updatedBy_fkey') THEN
    ALTER TABLE "Guideline" ADD CONSTRAINT "Guideline_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ArtistApplicationRecommendation
CREATE TABLE IF NOT EXISTS "ArtistApplicationRecommendation" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArtistApplicationRecommendation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ArtistApplicationRecommendation_applicationId_idx" ON "ArtistApplicationRecommendation"("applicationId");
CREATE INDEX IF NOT EXISTS "ArtistApplicationRecommendation_moderatorId_idx" ON "ArtistApplicationRecommendation"("moderatorId");
CREATE UNIQUE INDEX IF NOT EXISTS "ArtistApplicationRecommendation_applicationId_moderatorId_key" ON "ArtistApplicationRecommendation"("applicationId", "moderatorId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ArtistApplicationRecommendation_applicationId_fkey') THEN
    ALTER TABLE "ArtistApplicationRecommendation" ADD CONSTRAINT "ArtistApplicationRecommendation_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "ArtistApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ArtistApplicationRecommendation_moderatorId_fkey') THEN
    ALTER TABLE "ArtistApplicationRecommendation" ADD CONSTRAINT "ArtistApplicationRecommendation_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ModerationLog
CREATE TABLE IF NOT EXISTS "ModerationLog" (
    "id" TEXT NOT NULL,
    "action" "ModerationAction" NOT NULL,
    "moderatorId" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModerationLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ModerationLog_moderatorId_idx" ON "ModerationLog"("moderatorId");
CREATE INDEX IF NOT EXISTS "ModerationLog_action_idx" ON "ModerationLog"("action");
CREATE INDEX IF NOT EXISTS "ModerationLog_createdAt_idx" ON "ModerationLog"("createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ModerationLog_moderatorId_fkey') THEN
    ALTER TABLE "ModerationLog" ADD CONSTRAINT "ModerationLog_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
