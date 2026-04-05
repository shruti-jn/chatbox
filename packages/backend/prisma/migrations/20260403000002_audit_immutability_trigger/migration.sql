-- Database-level immutability for audit_events
-- ORM-level enforcement (Prisma $extends) can be bypassed by direct SQL.
-- This trigger ensures even superusers cannot UPDATE or DELETE audit records.
--
-- Escape hatch: SET LOCAL app.allow_audit_cleanup = 'true' within a transaction
-- to allow test cleanup. This is transaction-scoped and cannot leak.

CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow cleanup in test transactions that explicitly opt in
  IF current_setting('app.allow_audit_cleanup', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events table is append-only: % not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_immutable_trigger
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
