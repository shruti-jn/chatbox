-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('student', 'teacher', 'district_admin');

-- CreateEnum
CREATE TYPE "GradeBand" AS ENUM ('k2', 'g35', 'g68', 'g912');

-- CreateEnum
CREATE TYPE "InteractionModel" AS ENUM ('single_user', 'turn_based', 'concurrent');

-- CreateEnum
CREATE TYPE "AppReviewStatus" AS ENUM ('pending_review', 'approved', 'rejected', 'suspended');

-- CreateEnum
CREATE TYPE "CatalogStatus" AS ENUM ('approved', 'rejected', 'suspended');

-- CreateEnum
CREATE TYPE "AppInstanceStatus" AS ENUM ('loading', 'active', 'suspended', 'collapsed', 'terminated', 'error');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('student', 'assistant', 'system', 'teacher_whisper');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('active', 'closed');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('pending', 'granted', 'denied', 'revoked');

-- CreateEnum
CREATE TYPE "DeletionStatus" AS ENUM ('pending', 'in_progress', 'completed');

-- CreateEnum
CREATE TYPE "SafetyEventType" AS ENUM ('pii_detected', 'injection_detected', 'content_blocked', 'crisis_detected', 'app_content_blocked');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('safe', 'warning', 'blocked', 'critical');

-- CreateEnum
CREATE TYPE "InvocationStatus" AS ENUM ('success', 'error', 'timeout');

-- CreateTable
CREATE TABLE "districts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "districts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schools" (
    "id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "school_id" TEXT,
    "role" "UserRole" NOT NULL,
    "display_name" TEXT NOT NULL,
    "external_id" TEXT,
    "grade_band" "GradeBand",
    "email_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classrooms" (
    "id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "school_id" TEXT,
    "teacher_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "join_code" TEXT NOT NULL,
    "grade_band" "GradeBand" NOT NULL,
    "ai_config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classrooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classroom_memberships" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classroom_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apps" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "developer_id" TEXT,
    "tool_definitions" JSONB NOT NULL,
    "ui_manifest" JSONB NOT NULL,
    "permissions" JSONB NOT NULL,
    "compliance_metadata" JSONB NOT NULL,
    "interaction_model" "InteractionModel" NOT NULL DEFAULT 'single_user',
    "review_status" "AppReviewStatus" NOT NULL DEFAULT 'pending_review',
    "review_results" JSONB,
    "version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "district_app_catalog" (
    "id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "status" "CatalogStatus" NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejection_reason" TEXT,

    CONSTRAINT "district_app_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classroom_app_configs" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classroom_app_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_instances" (
    "id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "status" "AppInstanceStatus" NOT NULL DEFAULT 'loading',
    "state_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "terminated_at" TIMESTAMP(3),

    CONSTRAINT "app_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "author_role" "MessageRole" NOT NULL,
    "content_parts" JSONB NOT NULL,
    "safety_verdict" JSONB,
    "token_count" INTEGER,
    "whisper_author_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collaborative_sessions" (
    "id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "app_instance_id" TEXT NOT NULL,
    "session_code" TEXT NOT NULL,
    "interaction_model" "InteractionModel" NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "collaborative_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_participants" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "color_assignment" TEXT,
    "turn_order" INTEGER,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMP(3),

    CONSTRAINT "session_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "access_token_encrypted" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "scopes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parental_consents" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "parent_email_hash" TEXT NOT NULL,
    "consent_status" "ConsentStatus" NOT NULL DEFAULT 'pending',
    "consent_date" TIMESTAMP(3),
    "revoked_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parental_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_deletion_requests" (
    "id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "status" "DeletionStatus" NOT NULL DEFAULT 'pending',

    CONSTRAINT "data_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_events" (
    "id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_type" "SafetyEventType" NOT NULL,
    "severity" "Severity" NOT NULL,
    "message_context_redacted" TEXT,
    "action_taken" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_invocations" (
    "id" TEXT NOT NULL,
    "district_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "app_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "parameters" JSONB,
    "result" JSONB,
    "status" "InvocationStatus" NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schools_district_id_idx" ON "schools"("district_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_external_id_key" ON "users"("external_id");

-- CreateIndex
CREATE INDEX "users_district_id_role_idx" ON "users"("district_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "classrooms_join_code_key" ON "classrooms"("join_code");

-- CreateIndex
CREATE INDEX "classrooms_teacher_id_idx" ON "classrooms"("teacher_id");

-- CreateIndex
CREATE INDEX "classroom_memberships_district_id_idx" ON "classroom_memberships"("district_id");

-- CreateIndex
CREATE UNIQUE INDEX "classroom_memberships_classroom_id_student_id_key" ON "classroom_memberships"("classroom_id", "student_id");

-- CreateIndex
CREATE INDEX "apps_review_status_idx" ON "apps"("review_status");

-- CreateIndex
CREATE UNIQUE INDEX "district_app_catalog_district_id_app_id_key" ON "district_app_catalog"("district_id", "app_id");

-- CreateIndex
CREATE INDEX "classroom_app_configs_district_id_idx" ON "classroom_app_configs"("district_id");

-- CreateIndex
CREATE UNIQUE INDEX "classroom_app_configs_classroom_id_app_id_key" ON "classroom_app_configs"("classroom_id", "app_id");

-- CreateIndex
CREATE INDEX "app_instances_conversation_id_status_idx" ON "app_instances"("conversation_id", "status");

-- CreateIndex
CREATE INDEX "app_instances_app_id_idx" ON "app_instances"("app_id");

-- CreateIndex
CREATE INDEX "conversations_classroom_id_student_id_idx" ON "conversations"("classroom_id", "student_id");

-- CreateIndex
CREATE INDEX "conversations_district_id_updated_at_idx" ON "conversations"("district_id", "updated_at");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_district_id_idx" ON "messages"("district_id");

-- CreateIndex
CREATE UNIQUE INDEX "collaborative_sessions_app_instance_id_key" ON "collaborative_sessions"("app_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "collaborative_sessions_session_code_key" ON "collaborative_sessions"("session_code");

-- CreateIndex
CREATE UNIQUE INDEX "session_participants_session_id_user_id_key" ON "session_participants"("session_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_tokens_user_id_provider_key" ON "oauth_tokens"("user_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "parental_consents_student_id_key" ON "parental_consents"("student_id");

-- CreateIndex
CREATE INDEX "parental_consents_district_id_idx" ON "parental_consents"("district_id");

-- CreateIndex
CREATE INDEX "audit_events_district_id_created_at_idx" ON "audit_events"("district_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_user_id_idx" ON "audit_events"("user_id");

-- CreateIndex
CREATE INDEX "audit_events_resource_type_resource_id_idx" ON "audit_events"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "safety_events_district_id_created_at_idx" ON "safety_events"("district_id", "created_at");

-- CreateIndex
CREATE INDEX "safety_events_severity_idx" ON "safety_events"("severity");

-- CreateIndex
CREATE INDEX "tool_invocations_app_id_created_at_idx" ON "tool_invocations"("app_id", "created_at");

-- CreateIndex
CREATE INDEX "tool_invocations_conversation_id_idx" ON "tool_invocations"("conversation_id");

-- AddForeignKey
ALTER TABLE "schools" ADD CONSTRAINT "schools_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classrooms" ADD CONSTRAINT "classrooms_teacher_id_fkey" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_memberships" ADD CONSTRAINT "classroom_memberships_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_memberships" ADD CONSTRAINT "classroom_memberships_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "district_app_catalog" ADD CONSTRAINT "district_app_catalog_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "district_app_catalog" ADD CONSTRAINT "district_app_catalog_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_app_configs" ADD CONSTRAINT "classroom_app_configs_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classroom_app_configs" ADD CONSTRAINT "classroom_app_configs_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_instances" ADD CONSTRAINT "app_instances_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_instances" ADD CONSTRAINT "app_instances_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_instances" ADD CONSTRAINT "app_instances_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_whisper_author_id_fkey" FOREIGN KEY ("whisper_author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collaborative_sessions" ADD CONSTRAINT "collaborative_sessions_app_instance_id_fkey" FOREIGN KEY ("app_instance_id") REFERENCES "app_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "collaborative_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parental_consents" ADD CONSTRAINT "parental_consents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parental_consents" ADD CONSTRAINT "parental_consents_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_deletion_requests" ADD CONSTRAINT "data_deletion_requests_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_district_id_fkey" FOREIGN KEY ("district_id") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

