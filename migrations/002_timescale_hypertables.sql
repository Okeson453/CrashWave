-- Migration 002: Create time-series tables (plain Postgres, no TimescaleDB)
-- Replaces TimescaleDB hypertables with simple partitioned tables and indexes.
-- Retention: Use scheduled cleanup job (e.g., pg_cron) or app-level DELETE:
--   DELETE FROM multiplier_ticks WHERE time < NOW() - INTERVAL '30 days';
--   DELETE FROM health_checks_ts WHERE time < NOW() - INTERVAL '90 days';

-- Multiplier ticks (high-frequency time-series)
CREATE TABLE IF NOT EXISTS multiplier_ticks (
    time TIMESTAMPTZ NOT NULL,
    round_id UUID REFERENCES rounds(id) ON DELETE CASCADE,
    multiplier NUMERIC(18, 8) NOT NULL,
    source VARCHAR(32) CHECK (source IN ('websocket', 'dom', 'api', 'unknown')),
    latency_ms INTEGER,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_multiplier_ticks_time ON multiplier_ticks (time DESC);

-- Health checks time-series (for granular monitoring)
CREATE TABLE IF NOT EXISTS health_checks_ts (
    time TIMESTAMPTZ NOT NULL,
    component VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('OK', 'DEGRADED', 'FAILING', 'UNKNOWN')),
    message TEXT,
    metric_value NUMERIC(18, 8),
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_health_checks_ts_time ON health_checks_ts (time DESC);
