-- Migration 007: Prediction and prediction-outcome persistence
-- Enables auditability: what was predicted, was it accepted, what happened.

CREATE TABLE IF NOT EXISTS predictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_id VARCHAR(64) NOT NULL UNIQUE,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    round_id UUID REFERENCES rounds(id) ON DELETE SET NULL,
    external_round_id VARCHAR(255),
    model_name VARCHAR(128) NOT NULL,
    model_version VARCHAR(64) NOT NULL,
    feature_version VARCHAR(64) NOT NULL,
    target_version VARCHAR(64),
    target_threshold NUMERIC(18, 8) NOT NULL,
    score NUMERIC(18, 8) NOT NULL,
    probability NUMERIC(18, 8) NOT NULL,
    confidence NUMERIC(18, 8) NOT NULL,
    regime_id VARCHAR(64),
    regime_name VARCHAR(64),
    data_quality NUMERIC(18, 8),
    feature_summary JSONB,
    reasoning JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_predictions_round ON predictions(round_id);
CREATE INDEX IF NOT EXISTS idx_predictions_session ON predictions(session_id);
CREATE INDEX IF NOT EXISTS idx_predictions_created ON predictions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_model ON predictions(model_name, model_version);

CREATE TABLE IF NOT EXISTS prediction_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_id VARCHAR(64) NOT NULL REFERENCES predictions(prediction_id) ON DELETE CASCADE,
    round_id UUID REFERENCES rounds(id) ON DELETE SET NULL,
    risk_approved BOOLEAN,
    risk_rejection_reason TEXT,
    bet_executed BOOLEAN NOT NULL DEFAULT false,
    actual_crash_point NUMERIC(18, 8),
    threshold_hit BOOLEAN,
    prediction_correct BOOLEAN,
    probability_error NUMERIC(18, 8),
    absolute_error NUMERIC(18, 8),
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (prediction_id)
);

CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_resolved ON prediction_outcomes(resolved_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_correct ON prediction_outcomes(prediction_correct);
