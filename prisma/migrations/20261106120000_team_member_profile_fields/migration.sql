-- Team member profile: dedicated roleTitle, lastLoginAt, adminModuleOptions.
-- Migrate ADMIN_TEAM job titles previously stored in "phone" into roleTitle.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "roleTitle" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "adminModuleOptions" JSONB;

UPDATE "User" AS u
SET
  "roleTitle" = NULLIF(TRIM(u.phone), ''),
  phone = NULL
FROM "Role" r
WHERE u."roleId" = r.id
  AND r.name = 'ADMIN_TEAM'
  AND u."roleTitle" IS NULL
  AND u.phone IS NOT NULL
  AND TRIM(u.phone) <> '';
