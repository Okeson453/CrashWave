-- Migration 006: Balance tracking snapshots

CREATE TABLE IF NOT EXISTS balance_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    bet_id UUID REFERENCES bets(id) ON DELETE SET NULL,
    round_id UUID REFERENCES rounds(id) ON DELETE SET NULL,
    balance NUMERIC(18, 8) NOT NULL,
    unit VARCHAR(32) NOT NULL DEFAULT 'units',
    source VARCHAR(32) NOT NULL CHECK (source IN ('ui', 'api', 'websocket', 'estimated')),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_session ON balance_snapshots(session_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_bet ON balance_snapshots(bet_id);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_round ON balance_snapshots(round_id);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_observed ON balance_snapshots(observed_at DESC);

-- Check constraint
ALTER TABLE balance_snapshots DROP CONSTRAINT IF EXISTS chk_balance_positive;
ALTER TABLE balance_snapshots ADD CONSTRAINT chk_balance_positive CHECK (balance >= 0);
