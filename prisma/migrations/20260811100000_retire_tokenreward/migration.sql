-- Token Economy Phase 4: Retire TokenReward (legacy table).
-- Any rows not already in TokenLedger are backfilled first (idempotent via
-- `legacy:<id>` keys), then the legacy table is dropped. Safe to re-run.

-- Ensure every legacy user has a wallet (matches seed behavior).
INSERT INTO "UserWallet" ("id", "userId", "balance", "version")
SELECT 'legacy-wallet-' || r."userId", r."userId", 0, 1
FROM "TokenReward" r
WHERE NOT EXISTS (SELECT 1 FROM "UserWallet" w WHERE w."userId" = r."userId")
GROUP BY r."userId"
ON CONFLICT ("userId") DO NOTHING;

-- Backfill any legacy rows missing from the ledger (cumulative balanceAfter).
INSERT INTO "TokenLedger" ("id", "userId", "type", "amount", "balanceAfter", "reason", "sourceType", "sourceId", "idempotencyKey", "createdAt")
SELECT
  'legacy-' || r."id",
  r."userId",
  'EARN',
  r."amount",
  r."amount" + COALESCE((
    SELECT SUM(t."amount")
    FROM "TokenLedger" t
    WHERE t."userId" = r."userId"
      AND (t."createdAt" < r."createdAt"
        OR (t."createdAt" = r."createdAt" AND t."id" < 'legacy-' || r."id"))
  ), 0),
  r."reason",
  'LEGACY',
  r."id",
  'legacy:' || r."id",
  r."createdAt"
FROM "TokenReward" r
ON CONFLICT ("idempotencyKey") DO NOTHING;

-- Reconcile wallet balances for any user that had legacy rows.
UPDATE "UserWallet" w
SET "balance" = COALESCE((
  SELECT SUM(t."amount") FROM "TokenLedger" t WHERE t."userId" = w."userId"
), 0)
WHERE EXISTS (SELECT 1 FROM "TokenReward" r WHERE r."userId" = w."userId");

-- Drop the legacy table and its indexes.
DROP TABLE IF EXISTS "TokenReward";
