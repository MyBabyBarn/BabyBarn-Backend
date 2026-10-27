-- Optional product attributes shown on the admin product editor.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "gender" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "colour" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "colourName" TEXT;
