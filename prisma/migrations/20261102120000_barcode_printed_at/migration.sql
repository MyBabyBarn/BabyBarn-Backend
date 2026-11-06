-- AlterTable
ALTER TABLE "ProductBarcode" ADD COLUMN IF NOT EXISTS "printedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductBarcode_printedAt_idx" ON "ProductBarcode"("printedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductBarcode_sentToVendorAt_idx" ON "ProductBarcode"("sentToVendorAt");
