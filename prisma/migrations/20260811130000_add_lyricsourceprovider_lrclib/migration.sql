-- The live database's "LyricSourceProvider" enum contains a value `LRCLIB`
-- (used by 636 Lyric rows) that was added directly to the DB and is missing
-- from the Prisma schema. Without it, Prisma's generated client fails to
-- deserialize those rows (P2023), breaking every query that includes lyrics.
-- Idempotent (guarded) so it is safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'LRCLIB'
      AND enumtypid = '"LyricSourceProvider"'::regtype
  ) THEN
    ALTER TYPE "LyricSourceProvider" ADD VALUE 'LRCLIB';
  END IF;
END $$;
