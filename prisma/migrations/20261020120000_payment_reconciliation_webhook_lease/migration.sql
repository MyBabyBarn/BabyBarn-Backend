-- PAY-04: remember when a webhook claim started so a dead worker can be retried.
ALTER TABLE "StripeWebhookEvent" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);

-- PAY-01: paid checkout that did not create an order, kept until a retry fulfills it.
CREATE TABLE IF NOT EXISTS "PaymentReconciliation" (
    "id" SERIAL NOT NULL,
    "publicId" TEXT NOT NULL,
    "checkoutIntentPublicId" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "amountCents" INTEGER,
    "error" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentReconciliation_publicId_key" ON "PaymentReconciliation"("publicId");
CREATE INDEX IF NOT EXISTS "PaymentReconciliation_checkoutIntentPublicId_status_idx"
  ON "PaymentReconciliation"("checkoutIntentPublicId", "status");
