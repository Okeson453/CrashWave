-- Harden RLS: when app.platform_role is not set, require matching tenant_id.
-- Control plane / migrations set: SELECT set_config('app.platform_role', 'control_plane', false);

CREATE OR REPLACE FUNCTION app_is_platform() RETURNS BOOLEAN AS $$
BEGIN
  RETURN COALESCE(current_setting('app.platform_role', true), '') IN ('control_plane', 'migration', 'superuser');
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

-- Engine tables: row visible if platform role OR tenant matches (NULL tenant_id only for legacy single-tenant platform)
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
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I
           USING (
             app_is_platform()
             OR (
               app_current_tenant() IS NOT NULL
               AND (tenant_id = app_current_tenant() OR tenant_id IS NULL)
             )
           )
           WITH CHECK (
             app_is_platform()
             OR (
               app_current_tenant() IS NOT NULL
               AND (tenant_id = app_current_tenant() OR tenant_id IS NULL)
             )
           )',
        t
      );
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'skip %', t;
    WHEN undefined_column THEN
      RAISE NOTICE 'skip % no tenant_id', t;
    END;
  END LOOP;
END $$;

DROP POLICY IF EXISTS users_isolation ON users;
CREATE POLICY users_isolation ON users
  USING (app_is_platform() OR (app_current_tenant() IS NOT NULL AND id = app_current_tenant()));

DROP POLICY IF EXISTS subs_isolation ON subscriptions;
CREATE POLICY subs_isolation ON subscriptions
  USING (app_is_platform() OR (app_current_tenant() IS NOT NULL AND user_id = app_current_tenant()));

DROP POLICY IF EXISTS instances_isolation ON tenant_instances;
CREATE POLICY instances_isolation ON tenant_instances
  USING (app_is_platform() OR (app_current_tenant() IS NOT NULL AND user_id = app_current_tenant()));

DROP POLICY IF EXISTS audit_isolation ON platform_audit_logs;
CREATE POLICY audit_isolation ON platform_audit_logs
  USING (app_is_platform() OR (app_current_tenant() IS NOT NULL AND target_user_id = app_current_tenant()));

DROP POLICY IF EXISTS plans_write ON plans;
CREATE POLICY plans_write ON plans FOR ALL
  USING (app_is_platform())
  WITH CHECK (app_is_platform());
