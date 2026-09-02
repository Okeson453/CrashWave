-- Financial integrity hardening.
-- 1) Append-only financial events.
-- 2) Transactional outbox for durable event publication.
-- 3) Explicit bet transition guard at the database boundary.

CREATE TABLE IF NOT EXISTS financial_ledger_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bet_id UUID REFERENCES bets(id) ON DELETE RESTRICT,
    tenant_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'BET_INTENDED','BET_RESERVED','BET_PLACED','BET_CONFIRMED',
      'CASH_OUT_REQUESTED','CASH_OUT_CONFIRMED','BET_LOST',
      'BET_FAILED','BET_UNKNOWN','RECONCILED','MANUAL_OVERRIDE'
    )),
    amount NUMERIC(18,8),
    multiplier NUMERIC(18,8),
    external_reference TEXT,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    correlation_id TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_bet ON financial_ledger_events(bet_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_tenant ON financial_ledger_events(tenant_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_external_reference
  ON financial_ledger_events(event_type, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    correlation_id TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_outbox_pending
  ON event_outbox(created_at) WHERE published_at IS NULL;

CREATE OR REPLACE FUNCTION validate_bet_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('PENDING','RESERVED'),('PENDING','PLACED'),('PENDING','FAILED'),('PENDING','UNKNOWN'),
      ('RESERVED','PLACED'),('RESERVED','PENDING'),('RESERVED','FAILED'),('RESERVED','UNKNOWN'),
      ('PLACED','CONFIRMED'),('PLACED','ACTIVE'),('PLACED','LOST'),('PLACED','FAILED'),('PLACED','UNKNOWN'),
      ('CONFIRMED','ACTIVE'),('CONFIRMED','LOST'),('CONFIRMED','FAILED'),('CONFIRMED','UNKNOWN'),
      ('ACTIVE','CASH_OUT_REQUESTED'),('ACTIVE','LOST'),('ACTIVE','FAILED'),('ACTIVE','UNKNOWN'),
      ('CASH_OUT_REQUESTED','CASHED_OUT'),('CASH_OUT_REQUESTED','UNKNOWN'),('CASH_OUT_REQUESTED','LOST'),('CASH_OUT_REQUESTED','FAILED'),
      ('UNKNOWN','CASHED_OUT'),('UNKNOWN','LOST'),('UNKNOWN','FAILED'),('UNKNOWN','RECONCILED'),
      ('RECONCILED','RECONCILED')
    ) AS allowed(from_state,to_state)
    WHERE allowed.from_state = OLD.state AND allowed.to_state = NEW.state
  ) THEN
    RAISE EXCEPTION 'Invalid bet state transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_bet_transition ON bets;
CREATE TRIGGER trg_validate_bet_transition
BEFORE UPDATE OF state ON bets
FOR EACH ROW EXECUTE FUNCTION validate_bet_transition();

-- Existing rows must be reviewed before tenant_id is made NOT NULL. New writes
-- in tenant mode are enforced by the application/RLS migration below.
ALTER TABLE financial_ledger_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financial_ledger_tenant_isolation ON financial_ledger_events;
CREATE POLICY financial_ledger_tenant_isolation ON financial_ledger_events
USING (app_is_platform() OR (app_current_tenant() IS NOT NULL AND tenant_id = app_current_tenant()))
WITH CHECK (app_is_platform() OR (app_current_tenant() IS NOT NULL AND tenant_id = app_current_tenant()));

CREATE OR REPLACE FUNCTION deny_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Immutable audit/financial rows cannot be modified or deleted' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_financial_ledger_immutable ON financial_ledger_events;
CREATE TRIGGER trg_financial_ledger_immutable
BEFORE UPDATE OR DELETE ON financial_ledger_events
FOR EACH ROW EXECUTE FUNCTION deny_immutable_mutation();
