-- Phase 5 hardening: Row Level Security for multi-tenant isolation
-- session variable: app.tenant_id (set by engine: SET app.tenant_id = '<uuid>')

-- Helper: current tenant from session (NULL = platform / single-tenant unrestricted)
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.tenant_id', true), '')::UUID;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Enable RLS on tenant-scoped engine tables (policies allow NULL tenant for single-tenant ops)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sessions', 'bets', 'rounds', 'daily_stats', 'balance_snapshots',
    'analytics_snapshots', 'health_checks', 'config_versions', 'predictions'
  ]
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I
           USING (tenant_id IS NULL OR app_current_tenant() IS NULL OR tenant_id = app_current_tenant())
           WITH CHECK (tenant_id IS NULL OR app_current_tenant() IS NULL OR tenant_id = app_current_tenant())',
        t
      );
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'skip missing table %', t;
    WHEN undefined_column THEN
      RAISE NOTICE 'skip table % (no tenant_id)', t;
    END;
  END LOOP;
END $$;

-- Platform tables: only control-plane roles should access; deny anonymous
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plans_read ON plans;
CREATE POLICY plans_read ON plans FOR SELECT USING (true);

DROP POLICY IF EXISTS plans_write ON plans;
CREATE POLICY plans_write ON plans FOR ALL USING (app_current_tenant() IS NULL);

-- Users: tenant can only see self when app.tenant_id set; platform sees all
DROP POLICY IF EXISTS users_isolation ON users;
CREATE POLICY users_isolation ON users
  USING (app_current_tenant() IS NULL OR id = app_current_tenant());

DROP POLICY IF EXISTS subs_isolation ON subscriptions;
CREATE POLICY subs_isolation ON subscriptions
  USING (app_current_tenant() IS NULL OR user_id = app_current_tenant());

DROP POLICY IF EXISTS instances_isolation ON tenant_instances;
CREATE POLICY instances_isolation ON tenant_instances
  USING (app_current_tenant() IS NULL OR user_id = app_current_tenant());

DROP POLICY IF EXISTS audit_isolation ON platform_audit_logs;
CREATE POLICY audit_isolation ON platform_audit_logs
  USING (app_current_tenant() IS NULL OR target_user_id = app_current_tenant());
