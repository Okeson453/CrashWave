-- Terms & Conditions, stake customization, Pay-as-You-Go daily billing

CREATE TABLE IF NOT EXISTS terms_and_conditions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    effective_date TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_terms_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    terms_version TEXT NOT NULL REFERENCES terms_and_conditions(version),
    ip_address INET,
    user_agent TEXT,
    accepted_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, terms_version)
);

CREATE INDEX IF NOT EXISTS idx_terms_user ON user_terms_acceptances(user_id);
CREATE INDEX IF NOT EXISTS idx_terms_version ON user_terms_acceptances(terms_version);

ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_stake DECIMAL(18,2) DEFAULT 700;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stake_increase_paid BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stake_increase_fee DECIMAL(18,2) DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stake_increase_paid_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS stake_change_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    old_stake DECIMAL(18,2) NOT NULL,
    new_stake DECIMAL(18,2) NOT NULL,
    change_type TEXT CHECK (change_type IN ('default', 'increase', 'decrease', 'reset')) DEFAULT 'default',
    fee_paid DECIMAL(18,2) DEFAULT 0,
    changed_by TEXT DEFAULT 'user',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stake_history_user ON stake_change_history(user_id);

ALTER TABLE plans ADD COLUMN IF NOT EXISTS min_stake INT DEFAULT 700;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_stake INT DEFAULT 700;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS stake_configurable BOOLEAN DEFAULT false;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS billing_cycle TEXT DEFAULT 'monthly';

-- Relax check if needed (Postgres may not allow easy CHECK alter; set values carefully)
UPDATE plans SET billing_cycle = COALESCE(billing_cycle, 'monthly');

UPDATE plans SET
  fixed_stake = 700,
  min_stake = 700,
  max_stake = 700,
  stake_configurable = false,
  billing_cycle = 'monthly'
WHERE name = 'Starter';

UPDATE plans SET
  fixed_stake = 700,
  min_stake = 500,
  max_stake = 50000,
  stake_configurable = true,
  billing_cycle = 'monthly'
WHERE name = 'Pro';

UPDATE plans SET
  fixed_stake = 700,
  min_stake = 500,
  max_stake = 100000,
  stake_configurable = true,
  billing_cycle = 'monthly'
WHERE name = 'Whale';

UPDATE plans SET
  fixed_stake = 700,
  min_stake = 700,
  max_stake = 700,
  stake_configurable = false,
  billing_cycle = 'monthly'
WHERE name = 'Observer';

-- NGN monthly prices (design: 29k / 79k / 199k)
UPDATE plans SET price_monthly = 29000, currency = 'NGN' WHERE name = 'Starter' AND price_monthly < 1000;
UPDATE plans SET price_monthly = 79000, currency = 'NGN' WHERE name = 'Pro' AND price_monthly < 1000;
UPDATE plans SET price_monthly = 199000, currency = 'NGN' WHERE name = 'Whale' AND price_monthly < 1000;

INSERT INTO plans (name, price_monthly, currency, max_daily_entries, fixed_stake, fixed_target, allowed_modes, max_concurrent_sessions, features, is_active, billing_cycle, min_stake, max_stake, stake_configurable)
SELECT
  'Pay-as-You-Go', 2000.00, 'NGN', 30, 700, 1.30,
  ARRAY['dry-run','live'], 1,
  '{"analytics": false, "telegram_priority": false, "daily_billing": true}'::jsonb,
  true, 'daily', 700, 700, false
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = 'Pay-as-You-Go');

CREATE TABLE IF NOT EXISTS daily_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES plans(id),
    status TEXT CHECK (status IN ('active', 'expired', 'renewing', 'paused')) DEFAULT 'active',
    paid_date DATE NOT NULL,
    paid_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    auto_renew BOOLEAN DEFAULT true,
    payment_reference TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, paid_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_subs_user ON daily_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_subs_date ON daily_subscriptions(paid_date);
CREATE INDEX IF NOT EXISTS idx_daily_subs_status ON daily_subscriptions(status);

CREATE TABLE IF NOT EXISTS daily_billing_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    reminder_type TEXT CHECK (reminder_type IN ('morning', 'evening', 'expired')),
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    acknowledged BOOLEAN DEFAULT false
);

-- Seed default T&Cs v1.0
INSERT INTO terms_and_conditions (version, title, content, effective_date, is_active)
SELECT
  'v1.0',
  'BC.Game Crash Automation Platform — Terms of Service',
  $terms$
BC.GAME CRASH AUTOMATION PLATFORM — TERMS OF SERVICE
Version 1.0

1. SERVICE DESCRIPTION
This platform provides automated observation and betting assistance for BC.Game Crash. We do not guarantee profits, wins, or specific outcomes. All betting carries inherent risk of loss.

2. NO GUARANTEES
- Past performance does not indicate future results.
- The platform uses statistical analysis, not guaranteed prediction.
- You may lose your entire bankroll.
- We are not responsible for any losses incurred.

3. USER RESPONSIBILITIES
- You must be of legal gambling age in your jurisdiction.
- You provide your own BC.Game account and funds.
- You are solely responsible for your betting decisions.
- You will not hold the platform liable for losses.

4. SUBSCRIPTION & PAYMENTS
- Subscriptions are billed via virtual account transfer (Paystack).
- No refunds after service activation.
- Failure to pay results in immediate service suspension.

5. STAKE CUSTOMIZATION (Pro & Whale Only)
- You may configure your stake within your plan limits.
- Increasing stake beyond the default requires an additional fee (1.5x monthly fee).
- Higher stakes mean higher risk. You accept full responsibility.

6. PRIVACY & DATA
- Your BC.Game credentials are encrypted and never shared.
- We collect betting data for analytics only.
- You may request data deletion upon account closure.

7. TERMINATION
- We may terminate your account for abuse or platform misuse.
- You may cancel anytime; service continues until period end.

8. LIMITATION OF LIABILITY
- Maximum liability is limited to one month subscription fee.
- We are not liable for indirect, incidental, or consequential damages.

By accepting these terms, you acknowledge that:
(a) You understand the risks of automated betting.
(b) You will not pursue legal action for trading losses.
(c) You accept full responsibility for your betting activity.
$terms$,
  NOW(),
  true
WHERE NOT EXISTS (SELECT 1 FROM terms_and_conditions WHERE version = 'v1.0');
