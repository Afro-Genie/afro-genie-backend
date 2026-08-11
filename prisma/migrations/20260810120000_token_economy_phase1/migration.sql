-- Token Economy Phase 1: Wallet, Ledger, Tiers, Streaks
-- Idempotent (guarded) so it is safe to re-run on already-migrated databases.

-- Enums
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TokenTransactionType') THEN
    CREATE TYPE "TokenTransactionType" AS ENUM ('EARN', 'SPEND', 'PENALTY', 'TAX', 'ADMIN_ADJUST');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TierName') THEN
    CREATE TYPE "TierName" AS ENUM ('LISTENER', 'SCRIBE', 'MASTER_TRANSLATOR');
  END IF;
END $$;

-- UserWallet
CREATE TABLE IF NOT EXISTS "UserWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "UserWallet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserWallet_userId_key" ON "UserWallet"("userId");
CREATE INDEX IF NOT EXISTS "UserWallet_balance_idx" ON "UserWallet"("balance");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserWallet_userId_fkey') THEN
    ALTER TABLE "UserWallet" ADD CONSTRAINT "UserWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- TokenLedger
CREATE TABLE IF NOT EXISTS "TokenLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TokenTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TokenLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TokenLedger_idempotencyKey_key" ON "TokenLedger"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "TokenLedger_userId_createdAt_idx" ON "TokenLedger"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "TokenLedger_type_idx" ON "TokenLedger"("type");
CREATE INDEX IF NOT EXISTS "TokenLedger_sourceType_sourceId_idx" ON "TokenLedger"("sourceType", "sourceId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TokenLedger_userId_fkey') THEN
    ALTER TABLE "TokenLedger" ADD CONSTRAINT "TokenLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- UserTier
CREATE TABLE IF NOT EXISTS "UserTier" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "TierName" NOT NULL DEFAULT 'LISTENER',
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "approvedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserTier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserTier_userId_key" ON "UserTier"("userId");
CREATE INDEX IF NOT EXISTS "UserTier_tier_idx" ON "UserTier"("tier");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserTier_userId_fkey') THEN
    ALTER TABLE "UserTier" ADD CONSTRAINT "UserTier_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- UserStreak
CREATE TABLE IF NOT EXISTS "UserStreak" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastLoginDate" TIMESTAMP(3),
    CONSTRAINT "UserStreak_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserStreak_userId_key" ON "UserStreak"("userId");
CREATE INDEX IF NOT EXISTS "UserStreak_currentStreak_idx" ON "UserStreak"("currentStreak");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserStreak_userId_fkey') THEN
    ALTER TABLE "UserStreak" ADD CONSTRAINT "UserStreak_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
