-- Append-only audit log hardening.
CREATE OR REPLACE FUNCTION deny_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Audit logs are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_platform_audit_immutable ON platform_audit_logs;
CREATE TRIGGER trg_platform_audit_immutable
BEFORE UPDATE OR DELETE ON platform_audit_logs
FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();
