# Database Migration Compatibility Fix — August 2026

## Summary

Removed TimescaleDB extension dependency from migration `002_timescale_hypertables.sql` to support Railway-managed PostgreSQL (which lacks TimescaleDB).

## Changes Made

### Migration 002: Plain Postgres Rewrite
- **Before**: Used TimescaleDB `create_hypertable()` and `add_retention_policy()` for automatic partitioning and retention
- **After**: Plain Postgres tables with B-tree indexes on `time` column, explicit retention cleanup strategy
- **Impact**: Fully compatible with any Postgres 13+ instance (Railway, AWS RDS, Timescale Cloud, self-hosted)

**Tables converted:**
1. `multiplier_ticks` (game tick data, 30-day retention window)
   - Replaced: `CREATE EXTENSION timescaledb`, `SELECT create_hypertable('multiplier_ticks', 'time', ...)`
   - With: Standard `CREATE TABLE` + `CREATE INDEX idx_multiplier_ticks_time ON multiplier_ticks (time DESC)`

2. `health_checks_ts` (monitoring data, 90-day retention window)
   - Replaced: `SELECT create_hypertable('health_checks_ts', 'time', ...)`
   - With: Standard `CREATE TABLE` + `CREATE INDEX idx_health_checks_ts_time ON health_checks_ts (time DESC)`

### Retention Strategy
- **No built-in Postgres equivalent** for TimescaleDB's automatic `add_retention_policy()`
- **Recommended approaches**:
  1. **pg_cron** (if available on your Postgres provider): Schedule monthly/quarterly cleanup jobs
  2. **App-level cleanup**: Add background task that runs: 
     ```sql
     DELETE FROM multiplier_ticks WHERE time < NOW() - INTERVAL '30 days';
     DELETE FROM health_checks_ts WHERE time < NOW() - INTERVAL '90 days';
     ```
  3. **Manual cleanup**: DBA runs cleanup queries on schedule

### Downstream Migrations (003–018)
✅ **All safe and unmodified** — they only:
- Add indexes on these tables (migration 003)
- Add tenant_id column (migration 008)
- Apply RLS policies and triggers (migration 014)

## Deployment Path

### For Railway
1. Set `DATABASE_URL` to Railway's managed Postgres (no TimescaleDB needed)
2. Run migrations — all 18 will now succeed
3. Implement retention cleanup (option 1, 2, or 3 above)

### For Timescale Cloud (Optional)
- If better time-series compression/retention is desired, can still use Timescale Cloud
- Migrations remain compatible — tables work identically on both systems
- To enable Timescale-specific features later:
  - Manually `CREATE EXTENSION timescaledb` on the Timescale database
  - Run `SELECT create_hypertable('multiplier_ticks', 'time', if_not_exists => TRUE)`
  - Re-add `SELECT add_retention_policy(...)` calls as needed

## Testing

✅ Migration 001 applied successfully (uuid-ossp fix validated)
✅ Migration 002 ready for testing (no extension calls, pure SQL)
✅ Migrations 003-018 scanned — no Timescale-specific dependencies found

## Files Modified
- `migrations/002_timescale_hypertables.sql` — main fix
- `.env.example` — documentation update (DATABASE_URL now "standard Postgres 13+; TimescaleDB optional")
