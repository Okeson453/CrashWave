-- Paystack dedicated virtual accounts + payment transactions

CREATE TABLE IF NOT EXISTS virtual_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    paystack_customer_id TEXT NOT NULL,
    paystack_customer_code TEXT,
    paystack_dva_id TEXT NOT NULL,
    account_number VARCHAR(20) NOT NULL,
    bank_name TEXT NOT NULL,
    bank_code TEXT NOT NULL,
    account_name TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_va_user ON virtual_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_va_account ON virtual_accounts(account_number);
CREATE INDEX IF NOT EXISTS idx_va_customer ON virtual_accounts(paystack_customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_va_user_active
  ON virtual_accounts(user_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    virtual_account_id UUID REFERENCES virtual_accounts(id),
    paystack_reference TEXT NOT NULL,
    paystack_transfer_code TEXT,
    amount DECIMAL(18,2) NOT NULL,
    currency TEXT DEFAULT 'NGN',
    status TEXT CHECK (status IN ('pending', 'success', 'failed', 'reversed')) DEFAULT 'pending',
    paid_at TIMESTAMPTZ,
    channel TEXT DEFAULT 'bank_transfer',
    bank_name TEXT,
    bank_account TEXT,
    narration TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tx_user ON payment_transactions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_reference ON payment_transactions(paystack_reference);
CREATE INDEX IF NOT EXISTS idx_tx_status ON payment_transactions(status);

-- Optional unique active subscription per user for ON CONFLICT activation
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_user_active
    ON subscriptions(user_id)
    WHERE status IN ('active', 'trialing', 'past_due');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
