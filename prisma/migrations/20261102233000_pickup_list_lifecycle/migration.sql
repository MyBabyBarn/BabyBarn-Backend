-- Pickup Management PK-2: assignee + progress + completedAt on PickupList
ALTER TABLE "PickupList" ADD COLUMN IF NOT EXISTS "assignedToUserId" INTEGER;
ALTER TABLE "PickupList" ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP(3);
ALTER TABLE "PickupList" ADD COLUMN IF NOT EXISTS "assignedByUserId" INTEGER;
ALTER TABLE "PickupList" ADD COLUMN IF NOT EXISTS "progressPicked" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PickupList" ADD COLUMN IF NOT EXISTS "progressNeeded" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PickupList" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "PickupList_assignedToUserId_idx" ON "PickupList"("assignedToUserId");
CREATE INDEX IF NOT EXISTS "PickupList_completedAt_idx" ON "PickupList"("completedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PickupList_assignedToUserId_fkey'
  ) THEN
    ALTER TABLE "PickupList"
      ADD CONSTRAINT "PickupList_assignedToUserId_fkey"
      FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PickupList_assignedByUserId_fkey'
  ) THEN
    ALTER TABLE "PickupList"
      ADD CONSTRAINT "PickupList_assignedByUserId_fkey"
      FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
