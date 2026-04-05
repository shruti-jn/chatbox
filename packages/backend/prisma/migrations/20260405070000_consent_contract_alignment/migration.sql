ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "consent_status" "ConsentStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "deletion_scheduled_at" TIMESTAMP(3);

ALTER TABLE "data_deletion_requests"
  ADD COLUMN IF NOT EXISTS "reason" TEXT;
