-- CreateEnum
CREATE TYPE "GtPurchaseStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PassType" AS ENUM ('SEVEN_DAY_PREMIUM', 'TRANSLATION_PACK_10', 'TRANSLATION_PACK_50');

-- AlterTable
ALTER TABLE "StoreItem" ADD COLUMN     "featured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "limitedTime" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "originalPrice" INTEGER,
ADD COLUMN     "discountedPrice" INTEGER,
ADD COLUMN     "discountPercent" INTEGER,
ADD COLUMN     "promoStartsAt" TIMESTAMP(3),
ADD COLUMN     "promoEndsAt" TIMESTAMP(3),
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stock" INTEGER;

-- CreateTable
CREATE TABLE "GtBundle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gtAmount" INTEGER NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "badge" TEXT,
    "bonusPercent" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GtBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GtPurchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "bundleName" TEXT NOT NULL,
    "gtAmount" INTEGER NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "status" "GtPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "paystackRef" TEXT,
    "paystackAccess" TEXT,
    "paidAt" TIMESTAMP(3),
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GtPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PremiumPass" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "PassType" NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "gtCost" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PremiumPass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreItem_featured_idx" ON "StoreItem"("featured");

-- CreateIndex
CREATE INDEX "GtBundle_active_idx" ON "GtBundle"("active");

-- CreateIndex
CREATE INDEX "GtBundle_sortOrder_idx" ON "GtBundle"("sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "GtPurchase_paystackRef_key" ON "GtPurchase"("paystackRef");

-- CreateIndex
CREATE INDEX "GtPurchase_userId_createdAt_idx" ON "GtPurchase"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "GtPurchase_paystackRef_idx" ON "GtPurchase"("paystackRef");

-- CreateIndex
CREATE INDEX "GtPurchase_status_idx" ON "GtPurchase"("status");

-- CreateIndex
CREATE INDEX "GtPurchase_bundleId_idx" ON "GtPurchase"("bundleId");

-- CreateIndex
CREATE INDEX "PremiumPass_userId_active_idx" ON "PremiumPass"("userId", "active");

-- CreateIndex
CREATE INDEX "PremiumPass_expiresAt_idx" ON "PremiumPass"("expiresAt");

-- AddForeignKey
ALTER TABLE "GtPurchase" ADD CONSTRAINT "GtPurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GtPurchase" ADD CONSTRAINT "GtPurchase_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "GtBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PremiumPass" ADD CONSTRAINT "PremiumPass_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
