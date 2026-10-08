-- Refunds / reversal (GT plan item 9).
ALTER TYPE "TokenTransactionType" ADD VALUE 'REFUND';
ALTER TABLE "StorePurchase" ADD COLUMN "refundedAt" TIMESTAMP(3);
