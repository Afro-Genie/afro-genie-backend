-- Fix schema drift: ensure user_community_memberships has the correct schema
-- This handles two scenarios:
--   1. Table doesn't exist at all (create it with "id" as PK)
--   2. Table exists but with composite PK ("userId", "categoryId") instead of "id"

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'user_community_memberships'
  ) THEN
    -- Table doesn't exist yet — create it with the correct schema
    CREATE TABLE "user_community_memberships" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "categoryId" TEXT NOT NULL,
      "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "user_community_memberships_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "user_community_memberships_userId_categoryId_key" ON "user_community_memberships"("userId", "categoryId");
    ALTER TABLE "user_community_memberships" ADD CONSTRAINT "user_community_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    ALTER TABLE "user_community_memberships" ADD CONSTRAINT "user_community_memberships_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ForumCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ELSE
    -- Table exists — ensure the "id" column is present
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'user_community_memberships' AND column_name = 'id'
    ) THEN
      ALTER TABLE "user_community_memberships" DROP CONSTRAINT "user_community_memberships_pkey";
      ALTER TABLE "user_community_memberships" ADD COLUMN "id" TEXT NOT NULL DEFAULT (replace(gen_random_uuid()::text, '-', ''));
      ALTER TABLE "user_community_memberships" ADD CONSTRAINT "user_community_memberships_pkey" PRIMARY KEY ("id");
      CREATE UNIQUE INDEX IF NOT EXISTS "user_community_memberships_userId_categoryId_key" ON "user_community_memberships"("userId", "categoryId");
    END IF;
  END IF;
END $$;
