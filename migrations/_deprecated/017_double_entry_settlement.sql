-- Double-entry settlement ledger + orders lifecycle (authoritative settlement wiring)
-- Accounts: ASSET:CASINO_HOT_WALLET, LIABILITY:UNSETTLED_EXPOSURE,
--           EQUITY:REALIZED_PNL, EXPENSE:CASINO_HOUSE_EDGE

CREATE TABLE IF NOT EXISTS ledger_accounts (
    code TEXT PRIMARY KEY,
    account_type TEXT NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'EXPENSE', 'REVENUE')),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ledger_accounts (code, account_type, name) VALUES
  ('ASSET:CASINO_HOT_WALLET', 'ASSET', 'External operator hot wallet balance'),
  ('LIABILITY:UNSETTLED_EXPOSURE', 'LIABILITY', 'Capital locked in active rounds'),
  ('EQUITY:REALIZED_PNL', 'EQUITY', 'Cumulative realized profit or loss'),
  ('EXPENSE:CASINO_HOUSE_EDGE', 'EXPENSE', 'House edge and platform fees')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS settlement_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_order_id TEXT NOT NULL,
    tenant_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    bet_id UUID REFERENCES bets(id) ON DELETE RESTRICT,
    game_id TEXT,
    round_id TEXT,
    wager_amount NUMERIC(18,8) NOT NULL,
    target_multiplier NUMERIC(18,8),
    status TEXT NOT NULL DEFAULT 'ORDER_INTENT'
      CHECK (status IN (
        'ORDER_INTENT', 'DISPATCHED', 'PENDING_SETTLEMENT', 'RECONCILING',
        'SETTLED_WIN', 'SETTLED_LOSS', 'VOID', 'FAILED'
      )),
    gross_payout NUMERIC(18,8),
    exit_multiplier NUMERIC(18,8),
    external_reference TEXT,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_order_id)
);

CREATE INDEX IF NOT EXISTS idx_settlement_orders_status ON settlement_orders(status) WHERE status NOT IN ('SETTLED_WIN','SETTLED_LOSS','VOID');
CREATE INDEX IF NOT EXISTS idx_settlement_orders_bet ON settlement_orders(bet_id);
CREATE INDEX IF NOT EXISTS idx_settlement_orders_tenant ON settlement_orders(tenant_id, created_at DESC);

-- Double-entry journal lines (must balance per order within a transaction)
CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES settlement_orders(id) ON DELETE RESTRICT,
    account TEXT NOT NULL REFERENCES ledger_accounts(code),
    debit NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    memo TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (debit = 0 OR credit = 0),
    CHECK (debit > 0 OR credit > 0)
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_order ON ledger_entries(order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account, created_at);

-- Balance snapshots for drift detection
CREATE TABLE IF NOT EXISTS ledger_balance_cache (
    account TEXT PRIMARY KEY REFERENCES ledger_accounts(code),
    balance NUMERIC(18,8) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ledger_balance_cache (account, balance)
SELECT code, 0 FROM ledger_accounts
ON CONFLICT (account) DO NOTHING;

-- Immutable ledger entries
CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER trg_ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

-- Settlement order transition guard
CREATE OR REPLACE FUNCTION validate_settlement_order_transition() RETURNS trigger AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('ORDER_INTENT','DISPATCHED'),
      ('ORDER_INTENT','FAILED'),
      ('DISPATCHED','PENDING_SETTLEMENT'),
      ('DISPATCHED','RECONCILING'),
      ('DISPATCHED','SETTLED_WIN'),
      ('DISPATCHED','SETTLED_LOSS'),
      ('DISPATCHED','VOID'),
      ('DISPATCHED','FAILED'),
      ('PENDING_SETTLEMENT','SETTLED_WIN'),
      ('PENDING_SETTLEMENT','SETTLED_LOSS'),
      ('PENDING_SETTLEMENT','VOID'),
      ('PENDING_SETTLEMENT','RECONCILING'),
      ('RECONCILING','SETTLED_WIN'),
      ('RECONCILING','SETTLED_LOSS'),
      ('RECONCILING','VOID'),
      ('RECONCILING','FAILED')
    ) AS t(a,b) WHERE t.a = OLD.status AND t.b = NEW.status
  ) THEN
    RAISE EXCEPTION 'Invalid settlement_orders transition: % -> %', OLD.status, NEW.status;
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_settlement_order_transition ON settlement_orders;
CREATE TRIGGER trg_settlement_order_transition
BEFORE UPDATE OF status ON settlement_orders
FOR EACH ROW EXECUTE FUNCTION validate_settlement_order_transition();

-- RLS
ALTER TABLE settlement_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS settlement_orders_tenant ON settlement_orders;
CREATE POLICY settlement_orders_tenant ON settlement_orders
  USING (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = '')
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true) OR current_setting('app.tenant_id', true) = '');
