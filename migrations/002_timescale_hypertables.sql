-- Migration 002: Create TimescaleDB hypertables for time-series data
-- Requires TimescaleDB extension

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Multiplier ticks (high-frequency time-series)
CREATE TABLE IF NOT EXISTS multiplier_ticks (
    time TIMESTAMPTZ NOT NULL,
    round_id UUID REFERENCES rounds(id) ON DELETE CASCADE,
    multiplier NUMERIC(18, 8) NOT NULL,
    source VARCHAR(32) CHECK (source IN ('websocket', 'dom', 'api', 'unknown')),
    latency_ms INTEGER,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL
);

-- Convert to hypertable
SELECT create_hypertable('multiplier_ticks', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- Health checks time-series (for granular monitoring)
CREATE TABLE IF NOT EXISTS health_checks_ts (
    time TIMESTAMPTZ NOT NULL,
    component VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('OK', 'DEGRADED', 'FAILING', 'UNKNOWN')),
    message TEXT,
    metric_value NUMERIC(18, 8),
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL
);

SELECT create_hypertable('health_checks_ts', 'time', if_not_exists => TRUE, migrate_data => TRUE);

-- Set retention policies (30 days for ticks, 90 days for health checks)
SELECT add_retention_policy('multiplier_ticks', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('health_checks_ts', INTERVAL '90 days', if_not_exists => TRUE);
