-- Tenant hardening: never allow tenant-scoped writes without an explicit tenant
-- in tenant mode. Legacy NULL rows remain readable only by platform role.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','bets','rounds','multiplier_ticks','daily_stats','balance_snapshots','analytics_snapshots','health_checks','config_versions','predictions']
  LOOP
    BEGIN
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format($policy$
        CREATE POLICY tenant_isolation ON %I
        USING (app_is_platform() OR (app_current_tenant() IS NOT NULL AND tenant_id = app_current_tenant()))
        WITH CHECK (app_is_platform() OR (app_current_tenant() IS NOT NULL AND tenant_id = app_current_tenant()))
      $policy$, t);
    EXCEPTION WHEN undefined_table THEN NULL;
    WHEN undefined_column THEN NULL;
    END;
  END LOOP;
END $$;

-- Fail closed for the engine role: a tenant engine must never silently become
-- platform-wide because TENANT_ID was missing.
CREATE OR REPLACE FUNCTION require_tenant_for_engine_write() RETURNS trigger AS $$
BEGIN
  IF NOT app_is_platform() AND app_current_tenant() IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required for tenant-scoped writes' USING ERRCODE = '42501';
  END IF;
  IF NOT app_is_platform() AND NEW.tenant_id IS DISTINCT FROM app_current_tenant() THEN
    RAISE EXCEPTION 'Tenant mismatch: row tenant does not match database tenant context' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','bets','rounds','multiplier_ticks','daily_stats','balance_snapshots','analytics_snapshots','health_checks','config_versions','predictions']
  LOOP
    BEGIN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_require_tenant_context ON %I', t);
      EXECUTE format('CREATE TRIGGER trg_require_tenant_context BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION require_tenant_for_engine_write()', t);
    EXCEPTION WHEN undefined_table THEN NULL;
    WHEN undefined_column THEN NULL;
    END;
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions','bets','rounds','multiplier_ticks','daily_stats','balance_snapshots','analytics_snapshots','health_checks','config_versions','predictions']
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid', t);
    EXCEPTION WHEN undefined_table THEN NULL;
    WHEN undefined_column THEN NULL;
    END;
  END LOOP;
END $$;
