-- Migration 003: Performance indexes and constraints

-- Sessions indexes
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_mode ON sessions(mode);

-- Config versions index
CREATE INDEX IF NOT EXISTS idx_config_versions_active ON config_versions(active) WHERE active = true;

-- Rounds indexes
CREATE INDEX IF NOT EXISTS idx_rounds_session_id ON rounds(session_id);
CREATE INDEX IF NOT EXISTS idx_rounds_external_round_id ON rounds(external_round_id);
CREATE INDEX IF NOT EXISTS idx_rounds_started_at ON rounds(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_rounds_data_quality ON rounds(data_quality);

-- Bets indexes
CREATE INDEX IF NOT EXISTS idx_bets_session_id ON bets(session_id);
CREATE INDEX IF NOT EXISTS idx_bets_round_id ON bets(round_id);
CREATE INDEX IF NOT EXISTS idx_bets_daily_key ON bets(daily_key);
CREATE INDEX IF NOT EXISTS idx_bets_state ON bets(state);
CREATE INDEX IF NOT EXISTS idx_bets_created_at ON bets(created_at DESC);

-- Analytics snapshots index
CREATE INDEX IF NOT EXISTS idx_analytics_window ON analytics_snapshots(window_type, created_at DESC);

-- Multiplier ticks indexes (hypertable already has time index)
CREATE INDEX IF NOT EXISTS idx_ticks_round_id ON multiplier_ticks(round_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_ticks_session_id ON multiplier_ticks(session_id, time DESC);

-- Health checks indexes
CREATE INDEX IF NOT EXISTS idx_health_checks_component ON health_checks(component, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_health_checks_status ON health_checks(status, timestamp DESC);

-- Foreign key constraints (already defined in CREATE TABLE, but ensure they exist)
ALTER TABLE rounds DROP CONSTRAINT IF EXISTS fk_rounds_session;
ALTER TABLE rounds ADD CONSTRAINT fk_rounds_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE bets DROP CONSTRAINT IF EXISTS fk_bets_session;
ALTER TABLE bets ADD CONSTRAINT fk_bets_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE bets DROP CONSTRAINT IF EXISTS fk_bets_round;
ALTER TABLE bets ADD CONSTRAINT fk_bets_round FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE SET NULL;

-- Check constraints
ALTER TABLE bets DROP CONSTRAINT IF EXISTS chk_bets_stake_positive;
ALTER TABLE bets ADD CONSTRAINT chk_bets_stake_positive CHECK (stake > 0);

ALTER TABLE bets DROP CONSTRAINT IF EXISTS chk_bets_target_positive;
ALTER TABLE bets ADD CONSTRAINT chk_bets_target_positive CHECK (cash_out_target > 0);

ALTER TABLE config_versions DROP CONSTRAINT IF EXISTS chk_config_stake_positive;
ALTER TABLE config_versions ADD CONSTRAINT chk_config_stake_positive CHECK (stake_per_entry > 0);

ALTER TABLE config_versions DROP CONSTRAINT IF EXISTS chk_config_target_positive;
ALTER TABLE config_versions ADD CONSTRAINT chk_config_target_positive CHECK (cash_out_target > 0);

ALTER TABLE config_versions DROP CONSTRAINT IF EXISTS chk_config_max_daily_positive;
ALTER TABLE config_versions ADD CONSTRAINT chk_config_max_daily_positive CHECK (max_daily_entries > 0);
