-- SCL-03: index product name for catalog search prefix lookups.
CREATE INDEX IF NOT EXISTS "Product_name_idx" ON "Product"("name");
