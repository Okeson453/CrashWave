-- Migration 005: Aggregated daily metrics table

CREATE TABLE IF NOT EXISTS daily_stats (
    daily_key VARCHAR(10) PRIMARY KEY,
    entries_confirmed INTEGER NOT NULL DEFAULT 0,
    entries_attempted INTEGER NOT NULL DEFAULT 0,
    entries_failed INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    gross_profit NUMERIC(18, 8) NOT NULL DEFAULT 0,
    gross_loss NUMERIC(18, 8) NOT NULL DEFAULT 0,
    net_pnl NUMERIC(18, 8) NOT NULL DEFAULT 0,
    balance_start NUMERIC(18, 8),
    balance_end NUMERIC(18, 8),
    max_drawdown NUMERIC(18, 8) NOT NULL DEFAULT 0,
    current_drawdown NUMERIC(18, 8) NOT NULL DEFAULT 0,
    hit_rate NUMERIC(10, 6),
    average_latency_ms NUMERIC(10, 2),
    cash_out_success_rate NUMERIC(10, 6),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_daily_stats_updated ON daily_stats(updated_at DESC);

-- Check constraints
ALTER TABLE daily_stats DROP CONSTRAINT IF EXISTS chk_daily_entries_confirmed;
ALTER TABLE daily_stats ADD CONSTRAINT chk_daily_entries_confirmed CHECK (entries_confirmed >= 0);

ALTER TABLE daily_stats DROP CONSTRAINT IF EXISTS chk_daily_entries_attempted;
ALTER TABLE daily_stats ADD CONSTRAINT chk_daily_entries_attempted CHECK (entries_attempted >= 0);

ALTER TABLE daily_stats DROP CONSTRAINT IF EXISTS chk_daily_entries_failed;
ALTER TABLE daily_stats ADD CONSTRAINT chk_daily_entries_failed CHECK (entries_failed >= 0);

ALTER TABLE daily_stats DROP CONSTRAINT IF EXISTS chk_daily_wins;
ALTER TABLE daily_stats ADD CONSTRAINT chk_daily_wins CHECK (wins >= 0);

ALTER TABLE daily_stats DROP CONSTRAINT IF EXISTS chk_daily_losses;
ALTER TABLE daily_stats ADD CONSTRAINT chk_daily_losses CHECK (losses >= 0);
