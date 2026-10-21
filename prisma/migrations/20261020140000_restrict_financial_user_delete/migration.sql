-- DAT-01: deleting a customer must not erase orders, returns, membership payments, checkout intents, or store credit.
ALTER TABLE "MembershipPayment" DROP CONSTRAINT IF EXISTS "MembershipPayment_userId_fkey";
ALTER TABLE "MembershipPayment"
  ADD CONSTRAINT "MembershipPayment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CheckoutIntent" DROP CONSTRAINT IF EXISTS "CheckoutIntent_userId_fkey";
ALTER TABLE "CheckoutIntent"
  ADD CONSTRAINT "CheckoutIntent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_userId_fkey";
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReturnRequest" DROP CONSTRAINT IF EXISTS "ReturnRequest_userId_fkey";
ALTER TABLE "ReturnRequest"
  ADD CONSTRAINT "ReturnRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StoreCreditWallet" DROP CONSTRAINT IF EXISTS "StoreCreditWallet_userId_fkey";
ALTER TABLE "StoreCreditWallet"
  ADD CONSTRAINT "StoreCreditWallet_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PAY-03: keep the original order total; record refunded cents separately.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "refundedAmountCents" INTEGER NOT NULL DEFAULT 0;
