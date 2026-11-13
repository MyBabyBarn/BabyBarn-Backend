-- Product review hide reason (staff-only when REJECTED / Hidden).
ALTER TABLE "ProductReview" ADD COLUMN IF NOT EXISTS "hideReason" TEXT;

-- Platform feedback can be hidden from internal lists without deleting.
ALTER TYPE "PlatformReviewStatus" ADD VALUE IF NOT EXISTS 'HIDDEN';
