-- Order Management OM-4: staff assignee for Assign / Reassign queue ownership.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "assignedToUserId" INTEGER;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "assignedByUserId" INTEGER;

CREATE INDEX IF NOT EXISTS "Order_assignedToUserId_idx" ON "Order"("assignedToUserId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Order_assignedToUserId_fkey'
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_assignedToUserId_fkey"
      FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Order_assignedByUserId_fkey'
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_assignedByUserId_fkey"
      FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
