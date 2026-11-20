ALTER TABLE "StorePurchase"
  ADD COLUMN IF NOT EXISTS "shippingName" TEXT,
  ADD COLUMN IF NOT EXISTS "shippingAddress" TEXT;
