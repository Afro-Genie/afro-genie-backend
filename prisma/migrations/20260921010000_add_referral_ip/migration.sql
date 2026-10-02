-- AlterTable
ALTER TABLE "Referral" ADD COLUMN "ip" TEXT;

-- CreateIndex
CREATE INDEX "Referral_ip_createdAt_idx" ON "Referral"("ip", "createdAt");
