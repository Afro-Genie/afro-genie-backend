-- Fix schema drift: add missing "id" column to user_community_memberships
-- The original migration created this table with a composite PK ("userId", "categoryId")
-- but the Prisma schema expects "id" as the primary key.
-- This migration is idempotent: it only runs if the "id" column is missing.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_community_memberships' AND column_name = 'id'
  ) THEN
    -- Drop the composite primary key
    ALTER TABLE "user_community_memberships" DROP CONSTRAINT "user_community_memberships_pkey";

    -- Add "id" column (backfill existing rows with unique values)
    ALTER TABLE "user_community_memberships" ADD COLUMN "id" TEXT NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', ''));

    -- Set "id" as the new primary key
    ALTER TABLE "user_community_memberships" ADD CONSTRAINT "user_community_memberships_pkey" PRIMARY KEY ("id");

    -- Restore unique constraint on (userId, categoryId)
    CREATE UNIQUE INDEX IF NOT EXISTS "user_community_memberships_userId_categoryId_key" ON "user_community_memberships"("userId", "categoryId");
  END IF;
END $$;
