ALTER TABLE "User"
ADD COLUMN "moderatorWelcomedAt" TIMESTAMP(3);

UPDATE "User" AS "user"
SET "moderatorWelcomedAt" = (
  SELECT MIN("action"."createdAt")
  FROM "ModActionLog" AS "action"
  WHERE "action"."targetId" = "user"."id"
    AND "action"."actionType" = 'WELCOME_MESSAGE_SENT'
    AND "action"."targetType" = 'user'
)
WHERE EXISTS (
  SELECT 1
  FROM "ModActionLog" AS "action"
  WHERE "action"."targetId" = "user"."id"
    AND "action"."actionType" = 'WELCOME_MESSAGE_SENT'
    AND "action"."targetType" = 'user'
);
