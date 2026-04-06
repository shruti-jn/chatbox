-- Schema sync: adds columns and tables created via db push that are missing from migrations

-- Add health_url to apps (used by app health monitoring)
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "health_url" TEXT;

-- Add last_heartbeat_at to app_instances (used by heartbeat watchdog)
ALTER TABLE "app_instances" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "app_instances_last_heartbeat_at_idx" ON "app_instances"("last_heartbeat_at");

-- Add scheduled_delete_by to data_deletion_requests
ALTER TABLE "data_deletion_requests" ADD COLUMN IF NOT EXISTS "scheduled_delete_by" TIMESTAMP(3);

-- Create email_outbox table
CREATE TABLE IF NOT EXISTS "email_outbox" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "district_id" TEXT NOT NULL,
    "recipient_hash" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "email_outbox_district_id_idx" ON "email_outbox"("district_id");
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_district_id_fkey"
    FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create app_invocation_jobs table
CREATE TABLE IF NOT EXISTS "app_invocation_jobs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "instance_id" TEXT,
    "conversation_id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "last_heartbeat_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "result" JSONB,
    "error_code" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT true,
    "resume_token" TEXT,
    "resumed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_invocation_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "app_invocation_jobs_request_key_key" ON "app_invocation_jobs"("request_key");
CREATE UNIQUE INDEX IF NOT EXISTS "app_invocation_jobs_resume_token_key" ON "app_invocation_jobs"("resume_token");
CREATE INDEX IF NOT EXISTS "app_invocation_jobs_status_priority_queued_at_idx" ON "app_invocation_jobs"("status", "priority", "queued_at");
CREATE INDEX IF NOT EXISTS "app_invocation_jobs_status_deadline_at_idx" ON "app_invocation_jobs"("status", "deadline_at");
CREATE INDEX IF NOT EXISTS "app_invocation_jobs_district_id_idx" ON "app_invocation_jobs"("district_id");
CREATE INDEX IF NOT EXISTS "app_invocation_jobs_conversation_id_idx" ON "app_invocation_jobs"("conversation_id");
CREATE INDEX IF NOT EXISTS "app_invocation_jobs_instance_id_idx" ON "app_invocation_jobs"("instance_id");
ALTER TABLE "app_invocation_jobs" ADD CONSTRAINT "app_invocation_jobs_district_id_fkey"
    FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "app_invocation_jobs" ADD CONSTRAINT "app_invocation_jobs_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create app_health_events table (if not exists)
CREATE TABLE IF NOT EXISTS "app_health_events" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "app_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latency_ms" INTEGER,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_health_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "app_health_events_app_id_created_at_idx" ON "app_health_events"("app_id", "created_at");
