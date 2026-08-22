-- ACIE v3 SOL records — rich contextual outcomes for calibration feedback
CREATE TABLE IF NOT EXISTS sol_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        TEXT NOT NULL,
  tenant_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  crash_point     DOUBLE PRECISION NOT NULL,
  reached_130     BOOLEAN NOT NULL,
  previous_outcomes JSONB NOT NULL DEFAULT '[]',
  previous_reached_130 JSONB NOT NULL DEFAULT '[]',
  sequence_state  JSONB NOT NULL DEFAULT '{}',
  regime          TEXT NOT NULL DEFAULT 'unknown',
  regime_duration INTEGER NOT NULL DEFAULT 0,
  psi_probability DOUBLE PRECISION NOT NULL,
  psi_confidence  DOUBLE PRECISION NOT NULL DEFAULT 0,
  prediction      BOOLEAN NOT NULL DEFAULT FALSE,
  actual_result   BOOLEAN NOT NULL,
  probability_residual DOUBLE PRECISION NOT NULL,
  squared_error   DOUBLE PRECISION NOT NULL,
  log_loss        DOUBLE PRECISION NOT NULL,
  binned_probability DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sol_records_recorded_at ON sol_records (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sol_records_tenant ON sol_records (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sol_records_regime ON sol_records (regime);
CREATE INDEX IF NOT EXISTS idx_sol_records_bin ON sol_records (binned_probability);
