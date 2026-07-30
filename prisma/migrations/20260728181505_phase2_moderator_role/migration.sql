-- Phase 2: Moderator Role Completion
-- GUARDIAN badge, ContentReport model, FLAGGED_CONTENT notification type, ReportStatus enum

-- Add GUARDIAN to BadgeType enum
ALTER TYPE "BadgeType" ADD VALUE 'GUARDIAN';

-- Add FLAGGED_CONTENT to NotificationType enum
ALTER TYPE "NotificationType" ADD VALUE 'FLAGGED_CONTENT';

-- Create ReportStatus enum
DO $$ BEGIN
  CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'DISMISSED', 'RESOLVED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create ContentReport table
CREATE TABLE "ContentReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "moderatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

-- Add foreign keys
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add indexes
CREATE INDEX "ContentReport_reporterId_idx" ON "ContentReport"("reporterId");
CREATE INDEX "ContentReport_moderatorId_idx" ON "ContentReport"("moderatorId");
CREATE INDEX "ContentReport_status_idx" ON "ContentReport"("status");
CREATE INDEX "ContentReport_targetType_targetId_idx" ON "ContentReport"("targetType", "targetId");
CREATE INDEX "ContentReport_createdAt_idx" ON "ContentReport"("createdAt");
