-- Migration 001: Initialize core relational tables
-- Tables: sessions, config_versions, rounds, bets, health_checks, analytics_snapshots
-- UUID generation: using native gen_random_uuid() (Postgres 13+, no extension required)

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    mode VARCHAR(32) NOT NULL DEFAULT 'observe-only' CHECK (mode IN ('observe-only', 'dry-run', 'live', 'maintenance')),
    browser_profile_id VARCHAR(255),
    operator_id VARCHAR(255),
    status VARCHAR(32) NOT NULL DEFAULT 'initializing' CHECK (status IN ('initializing', 'authenticating', 'loading_game', 'observing', 'betting_active', 'paused', 'error', 'recovering', 'stopped')),
    config_version INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Config versions (immutable history)
CREATE TABLE IF NOT EXISTS config_versions (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    stake_per_entry NUMERIC(18, 8) NOT NULL DEFAULT 700,
    cash_out_target NUMERIC(18, 8) NOT NULL DEFAULT 1.30,
    max_daily_entries INTEGER NOT NULL DEFAULT 100,
    timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
    changed_by VARCHAR(255),
    reason TEXT,
    approved_by VARCHAR(255),
    active BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT config_versions_unique_active UNIQUE (active)
);

-- Insert initial config version
INSERT INTO config_versions (stake_per_entry, cash_out_target, max_daily_entries, timezone, changed_by, reason, active)
VALUES (700, 1.30, 100, 'UTC', 'system', 'Initial default configuration', true)
ON CONFLICT DO NOTHING;

-- Rounds table
CREATE TABLE IF NOT EXISTS rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_round_id VARCHAR(255),
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ,
    crashed_at TIMESTAMPTZ,
    observed_crash_point NUMERIC(18, 8),
    final_confirmed_crash_point NUMERIC(18, 8),
    observation_source VARCHAR(32) CHECK (observation_source IN ('websocket', 'dom', 'api', 'unknown')),
    data_quality VARCHAR(32) CHECK (data_quality IN ('high', 'medium', 'low')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bets table
CREATE TABLE IF NOT EXISTS bets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    round_id UUID REFERENCES rounds(id) ON DELETE SET NULL,
    daily_key VARCHAR(10) NOT NULL,
    stake NUMERIC(18, 8) NOT NULL,
    cash_out_target NUMERIC(18, 8) NOT NULL,
    state VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RESERVED', 'PLACED', 'CONFIRMED', 'ACTIVE', 'CASH_OUT_REQUESTED', 'CASHED_OUT', 'LOST', 'FAILED', 'UNKNOWN', 'RECONCILED')),
    requested_at TIMESTAMPTZ,
    placed_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ,
    cash_out_requested_at TIMESTAMPTZ,
    cash_out_confirmed_at TIMESTAMPTZ,
    observed_cash_out_multiplier NUMERIC(18, 8),
    confirmed_cash_out_multiplier NUMERIC(18, 8),
    pnl NUMERIC(18, 8),
    balance_before NUMERIC(18, 8),
    balance_after NUMERIC(18, 8),
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Health checks table
CREATE TABLE IF NOT EXISTS health_checks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    component VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('OK', 'DEGRADED', 'FAILING', 'UNKNOWN')),
    message TEXT,
    metric_value NUMERIC(18, 8)
);

-- Analytics snapshots table
CREATE TABLE IF NOT EXISTS analytics_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    window_type VARCHAR(32) NOT NULL CHECK (window_type IN ('last_10', 'last_50', 'last_100', 'last_500', 'session', 'day', 'week', 'month', 'all')),
    window_size INTEGER,
    hit_rate NUMERIC(10, 6),
    confidence_lower NUMERIC(10, 6),
    confidence_upper NUMERIC(10, 6),
    expected_value NUMERIC(18, 8),
    realized_pnl NUMERIC(18, 8),
    max_drawdown NUMERIC(18, 8),
    current_drawdown NUMERIC(18, 8),
    win_streak_max INTEGER,
    loss_streak_max INTEGER,
    cash_out_success_rate NUMERIC(10, 6),
    recommendation TEXT
);
