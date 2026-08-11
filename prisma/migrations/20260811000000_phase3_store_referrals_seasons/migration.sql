-- Token Economy Phase 3: Store, Referrals, Seasonal Snapshots
-- Idempotent (guarded) so it is safe to re-run on already-migrated databases.

-- Enums
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PurchaseStatus') THEN
    CREATE TYPE "PurchaseStatus" AS ENUM ('PENDING_FULFILLMENT', 'FULFILLED', 'REFUNDED');
  END IF;
END $$;

-- Extend BadgeType (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'STORE' AND enumtypid = '"NotificationType"'::regtype) THEN
    ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'STORE';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DAILY_STREAK_7' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'DAILY_STREAK_7';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'FIRST_PROFILE' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'FIRST_PROFILE';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'GENEROUS_SUPPORTER' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'GENEROUS_SUPPORTER';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'SEASON_CHAMPION' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'SEASON_CHAMPION';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'REFERRAL_STAR' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'REFERRAL_STAR';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'GUARDIAN' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'GUARDIAN';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'HELPFUL_VOTER' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'HELPFUL_VOTER';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'FAN_FAVORITE' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'FAN_FAVORITE';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'GENIUS_ARTIST' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'GENIUS_ARTIST';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'MODERATION_QUEUE' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'MODERATION_QUEUE';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'PLATINUM_ARTIST' AND enumtypid = '"BadgeType"'::regtype) THEN
    ALTER TYPE "BadgeType" ADD VALUE IF NOT EXISTS 'PLATINUM_ARTIST';
  END IF;
END $$;

-- User.referralCode (unique)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'User' AND column_name = 'referralCode') THEN
    ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "User_referralCode_key" ON "User"("referralCode");

-- StoreItem
-- NOTE: a legacy "StoreItem" table may already exist on databases whose
-- migration history diverges from the local directory. CREATE IF NOT EXISTS
-- is a no-op there, so the ALTERs below reconcile it to the current model
-- (description nullable, updatedAt present) without touching any data.
CREATE TABLE IF NOT EXISTS "StoreItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "tokenCost" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "metadata" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoreItem_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'StoreItem'
      AND column_name = 'description' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "StoreItem" ALTER COLUMN "description" DROP NOT NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'StoreItem' AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "StoreItem" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "StoreItem_category_idx" ON "StoreItem"("category");
CREATE INDEX IF NOT EXISTS "StoreItem_active_idx" ON "StoreItem"("active");

-- StorePurchase
-- Same divergence story as StoreItem: a legacy table may exist missing the
-- status/purchaseToken/fulfilledAt columns, which we add idempotently below.
CREATE TABLE IF NOT EXISTS "StorePurchase" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spentAmount" INTEGER NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING_FULFILLMENT',
    "purchaseToken" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StorePurchase_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'StorePurchase' AND column_name = 'status'
  ) THEN
    ALTER TABLE "StorePurchase" ADD COLUMN "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING_FULFILLMENT';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'StorePurchase' AND column_name = 'purchaseToken'
  ) THEN
    ALTER TABLE "StorePurchase" ADD COLUMN "purchaseToken" TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'StorePurchase' AND column_name = 'fulfilledAt'
  ) THEN
    ALTER TABLE "StorePurchase" ADD COLUMN "fulfilledAt" TIMESTAMP(3);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "StorePurchase_purchaseToken_key" ON "StorePurchase"("purchaseToken");
CREATE INDEX IF NOT EXISTS "StorePurchase_userId_createdAt_idx" ON "StorePurchase"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "StorePurchase_status_idx" ON "StorePurchase"("status");
CREATE INDEX IF NOT EXISTS "StorePurchase_itemId_idx" ON "StorePurchase"("itemId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StorePurchase_itemId_fkey') THEN
    ALTER TABLE "StorePurchase" ADD CONSTRAINT "StorePurchase_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "StoreItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StorePurchase_userId_fkey') THEN
    ALTER TABLE "StorePurchase" ADD CONSTRAINT "StorePurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- UserEntitlement
CREATE TABLE IF NOT EXISTS "UserEntitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "metadata" JSONB,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserEntitlement_userId_type_key" ON "UserEntitlement"("userId", "type");
CREATE INDEX IF NOT EXISTS "UserEntitlement_userId_idx" ON "UserEntitlement"("userId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserEntitlement_userId_fkey') THEN
    ALTER TABLE "UserEntitlement" ADD CONSTRAINT "UserEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Referral
CREATE TABLE IF NOT EXISTS "Referral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Referral_referredUserId_key" ON "Referral"("referredUserId");
CREATE INDEX IF NOT EXISTS "Referral_referrerId_idx" ON "Referral"("referrerId");
CREATE INDEX IF NOT EXISTS "Referral_code_idx" ON "Referral"("code");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_referrerId_fkey') THEN
    ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Referral_referredUserId_fkey') THEN
    ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- SeasonalSnapshot
CREATE TABLE IF NOT EXISTS "SeasonalSnapshot" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SeasonalSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SeasonalSnapshot_period_key" ON "SeasonalSnapshot"("period");

-- UserBadge: dedupe + enforce uniqueness (userId, badgeType)
DELETE FROM "UserBadge"
USING "UserBadge" ub2
WHERE "UserBadge"."id" < ub2."id"
  AND "UserBadge"."userId" = ub2."userId"
  AND "UserBadge"."badgeType" = ub2."badgeType";

CREATE UNIQUE INDEX IF NOT EXISTS "UserBadge_userId_badgeType_key" ON "UserBadge"("userId", "badgeType");
