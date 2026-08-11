-- Normalize stale lowercase ReportTargetType enum values to the canonical
-- uppercase labels defined in schema.prisma / the ReportTargetType enum.
-- Prisma's generated client cannot deserialize lowercase values (P2023), which
-- breaks every ContentReport read path. Idempotent (guarded) so it is safe to
-- re-run: after the first run no rows match the WHERE clause.

UPDATE "ContentReport"
SET "targetType" = UPPER("targetType")
WHERE "targetType" <> UPPER("targetType");
