-- ChatBridge v2 Row-Level Security Policies
-- FERPA compliance: database-level tenant isolation
-- Uses SET LOCAL app.tenant_id per transaction (NEVER SET session-scoped)

-- Enable RLS on all tenant-scoped tables
-- NOTE: districts table is RLS-EXEMPT (tenant root entity — its id IS the tenant_id)
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE classrooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE classroom_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_app_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE classroom_app_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaborative_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE parental_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE safety_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations ENABLE ROW LEVEL SECURITY;

-- NOTE: apps table is RLS-EXEMPT (platform-global)

-- Create policies for each table
-- Pattern: current_setting('app.tenant_id') matches district_id column

CREATE POLICY school_isolation ON schools
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY user_isolation ON users
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY classroom_isolation ON classrooms
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY classroom_membership_isolation ON classroom_memberships
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY district_catalog_isolation ON district_app_catalog
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY classroom_app_config_isolation ON classroom_app_configs
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY app_instance_isolation ON app_instances
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY conversation_isolation ON conversations
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY message_isolation ON messages
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY collab_session_isolation ON collaborative_sessions
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY session_participant_isolation ON session_participants
  USING (session_id IN (
    SELECT id FROM collaborative_sessions
    WHERE district_id::text = current_setting('app.tenant_id', true)
  ));

CREATE POLICY oauth_token_isolation ON oauth_tokens
  USING (user_id IN (
    SELECT id FROM users
    WHERE district_id::text = current_setting('app.tenant_id', true)
  ));

CREATE POLICY consent_isolation ON parental_consents
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY deletion_request_isolation ON data_deletion_requests
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY email_outbox_isolation ON email_outbox
  USING (district_id::text = current_setting('app.tenant_id', true));

ALTER TABLE app_invocation_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY job_isolation ON app_invocation_jobs
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY audit_event_isolation ON audit_events
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY safety_event_isolation ON safety_events
  USING (district_id::text = current_setting('app.tenant_id', true));

CREATE POLICY tool_invocation_isolation ON tool_invocations
  USING (district_id::text = current_setting('app.tenant_id', true));

-- Database-level immutability for audit_events
-- ORM-level enforcement (Prisma $extends) can be bypassed by direct SQL.
-- This trigger ensures even superusers cannot UPDATE or DELETE audit records.
--
-- Escape hatch: SET LOCAL app.allow_audit_cleanup = 'true' within a transaction
-- to allow test cleanup. This is transaction-scoped and cannot leak.
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.allow_audit_cleanup', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events table is append-only: % not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_immutable_trigger
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
