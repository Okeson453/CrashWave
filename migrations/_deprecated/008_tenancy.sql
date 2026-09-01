-- Multi-tenant control plane schema
-- Plans first (referenced by users / subscriptions)

CREATE TABLE IF NOT EXISTS plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    price_monthly DECIMAL(10,2) NOT NULL,
    currency TEXT DEFAULT 'USD',
    max_daily_entries INT DEFAULT 100,
    fixed_stake INT DEFAULT 700,
    fixed_target DECIMAL(10,4) DEFAULT 1.30,
    allowed_modes TEXT[] DEFAULT ARRAY['observe-only', 'dry-run', 'live'],
    max_concurrent_sessions INT DEFAULT 1,
    features JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    telegram_username TEXT,
    email TEXT,
    status TEXT CHECK (status IN ('onboarding', 'active', 'suspended', 'cancelled', 'banned')) DEFAULT 'onboarding',
    plan_id UUID REFERENCES plans(id),
    bc_game_username_encrypted TEXT,
    bc_game_password_encrypted TEXT,
    bc_game_2fa_secret_encrypted TEXT,
    timezone TEXT DEFAULT 'UTC',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan_id);

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES plans(id),
    status TEXT CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')) DEFAULT 'trialing',
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT false,
    payment_provider TEXT DEFAULT 'stripe',
    payment_provider_subscription_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS tenant_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    container_id TEXT,
    container_host TEXT,
    status TEXT CHECK (status IN ('provisioning', 'running', 'paused', 'error', 'stopped', 'destroyed')) DEFAULT 'provisioning',
    mode TEXT DEFAULT 'observe-only',
    session_age_sec INT DEFAULT 0,
    last_heartbeat TIMESTAMPTZ,
    daily_entries_used INT DEFAULT 0,
    daily_reset_at TIMESTAMPTZ,
    pnl_today DECIMAL(18,8) DEFAULT 0,
    pnl_total DECIMAL(18,8) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instances_user ON tenant_instances(user_id);
CREATE INDEX IF NOT EXISTS idx_instances_status ON tenant_instances(status);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_type TEXT CHECK (actor_type IN ('system', 'admin', 'user', 'billing')),
    actor_id TEXT,
    action TEXT NOT NULL,
    target_user_id UUID REFERENCES users(id),
    payload JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_target ON platform_audit_logs(target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON platform_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON platform_audit_logs(created_at);

-- Optional tenant_id on engine tables (nullable — single-tenant still works)
DO $$ BEGIN
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE bets ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE rounds ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE multiplier_ticks ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE balance_snapshots ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE analytics_snapshots ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE health_checks ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE config_versions ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE predictions ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES users(id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Seed default plans (idempotent by name)
INSERT INTO plans (name, price_monthly, max_daily_entries, fixed_stake, fixed_target, allowed_modes, features)
SELECT 'Observer', 0, 0, 700, 1.30, ARRAY['observe-only'], '{"analytics": false, "telegram_priority": false}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = 'Observer');

INSERT INTO plans (name, price_monthly, max_daily_entries, fixed_stake, fixed_target, allowed_modes, features)
SELECT 'Starter', 29.00, 50, 700, 1.30, ARRAY['dry-run','live'], '{"analytics": true, "telegram_priority": false}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = 'Starter');

INSERT INTO plans (name, price_monthly, max_daily_entries, fixed_stake, fixed_target, allowed_modes, features)
SELECT 'Pro', 79.00, 100, 700, 1.30, ARRAY['dry-run','live'], '{"analytics": true, "telegram_priority": true}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = 'Pro');

INSERT INTO plans (name, price_monthly, max_daily_entries, fixed_stake, fixed_target, allowed_modes, features)
SELECT 'Whale', 199.00, 200, 700, 1.30, ARRAY['dry-run','live'], '{"analytics": true, "telegram_priority": true, "dedicated": true}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE name = 'Whale');
