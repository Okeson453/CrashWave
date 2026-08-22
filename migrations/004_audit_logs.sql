-- Migration 004: Immutable audit log table with partitioning

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor VARCHAR(255) NOT NULL,
    action VARCHAR(128) NOT NULL,
    entity_type VARCHAR(128) NOT NULL,
    entity_id VARCHAR(255),
    payload JSONB,
    severity VARCHAR(32) NOT NULL DEFAULT 'info' CHECK (severity IN ('trace', 'debug', 'info', 'warn', 'error', 'fatal'))
);

-- Partition by month for audit logs
-- Note: For simplicity in this migration, we use a regular table.
-- In production, consider native partitioning or TimescaleDB hypertable.

-- Indexes for audit log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON audit_logs(severity, timestamp DESC) WHERE severity IN ('error', 'fatal', 'warn');

-- Trigger to prevent updates (immutable)
CREATE OR REPLACE FUNCTION prevent_audit_update()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit logs are immutable and cannot be updated';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_immutable ON audit_logs;
CREATE TRIGGER audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_update();
