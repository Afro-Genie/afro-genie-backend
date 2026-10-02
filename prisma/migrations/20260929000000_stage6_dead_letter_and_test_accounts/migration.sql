-- Stage 6 (Class B) — additive schema changes. FORWARD-ONLY. No DROP, no
-- ALTER ... TYPE, no UPDATE, no CREATE TABLE.
--
-- Scope (REMEDIATION-PLAN.md §8):
--   6.1  Song.youtubeMatchAttempts  — dead-letter unmatchable songs
--   6.2  User.isTestAccount         — §3.5 archive, never delete
--   6.3  Translation[userId, createdAt] — challenge progress (M-10)
--
-- HAND-AUTHORED, DELIBERATELY NARROWER THAN `prisma migrate diff`.
-- The generated diff for this state also contained, and this file does NOT:
--   * 3 x DROP TABLE  (topic_comment_votes, topic_votes, user_community_memberships)
--   * 7 x DROP CONSTRAINT, 6 x DROP INDEX
--   * ALTER COLUMN ... DROP DEFAULT on Album/ContentReport/Guideline/ModPool/StoreItem
--   * CREATE TABLE for the 14 models that have no CREATE TABLE in any migration
-- Those belong to the Stage 1 §1.R9 drift repair, which needs its own review
-- and its own approval. Folding them into a "safe additive" migration would
-- have smuggled a destructive change past a rule written specifically to
-- catch exactly that. See REMEDIATION-RESULTS.md §6.R3.
--
-- Every statement below is idempotent on its own, so this file can also be
-- applied by hand (scripts/stage6-apply.cjs) against a database whose
-- _prisma_migrations ledger is missing, which is the current state of the
-- production target and the reason `migrate deploy` cannot be used there.

-- 6.1 — Song.youtubeMatchAttempts
-- Additive: new NOT NULL column with a constant DEFAULT. PostgreSQL 11+ applies
-- this without a table rewrite, so it is non-blocking on the 924-row catalog.
ALTER TABLE "Song" ADD COLUMN IF NOT EXISTS "youtubeMatchAttempts" INTEGER NOT NULL DEFAULT 0;

-- Supports the enrichment selection query, which filters on the counter to
-- exclude dead-lettered songs.
CREATE INDEX IF NOT EXISTS "Song_youtubeMatchAttempts_idx" ON "Song"("youtubeMatchAttempts");

-- 6.2 — User.isTestAccount
-- @default(false) is load-bearing: every pre-existing row reads as a real
-- account, so the column is inert until an operator explicitly flags a row.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isTestAccount" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "User_isTestAccount_idx" ON "User"("isTestAccount");

-- 6.3 — Translation [userId, createdAt]
-- M-10. challengeService.countDistinctSongs() filters on userId + a createdAt
-- range. Only single-column indexes existed, so PostgreSQL chose
-- Translation_createdAt_idx and filtered userId per row:
--   Aggregate -> Sort -> Index Scan using Translation_createdAt_idx
--              Filter: ("userId" = ...)
-- The composite index serves the userId equality first and the window second.
-- NOT a Translation->Challenge foreign key: progress is derived on demand from
-- the action tables (deliberately denormalisation-free, see challengeService
-- header), and Challenge rows are time-boxed and recreated weekly, so an FK
-- would encode a relationship that is a window, not a fact about a row.
CREATE INDEX IF NOT EXISTS "Translation_userId_createdAt_idx" ON "Translation"("userId", "createdAt");
