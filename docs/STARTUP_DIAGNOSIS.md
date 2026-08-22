# Startup Diagnosis Guide

## Healthcheck Failure Pattern

**Symptom:** Container starts but fails all 5 healthcheck attempts, returns 503/connection refused on `/health`.

**Possible causes** (in order of likelihood):

1. **Missing or invalid `DATABASE_URL`** — bootstrapping fails on DB connection validation
2. **Missing `REDIS_URL`** when the code expects it, or Redis unreachable
3. **Migrations fail** — `run-migrations.mjs` errors before the app ever starts
4. **Port mismatch** — app listening on different port than healthcheck probes
5. **Config validation fails** — Zod schema rejects values (e.g., negative numbers where positive required)

---

## Required Environment Variables

### **Absolutely Required** (app crashes on startup without these)

| Variable | Example | Notes |
|----------|---------|-------|
| `DATABASE_URL` | `postgresql://user:pass@db.example.com:5432/bc_crash` | PostgreSQL 15+ connection string; checked at startup |
| (Database credentials) | see above | Resolved from `DATABASE_URL` or `DATABASE_URL_FILE` |

### **Highly Recommended**

| Variable | Example | Default | Notes |
|----------|---------|---------|-------|
| `REDIS_URL` | `redis://localhost:6379` | (none) | If set but unreachable, app crashes; if unset, runs without Redis |
| `TENANT_MASTER_KEY` | (32+ char string) | (none) | Required only if using encrypted credentials; crashes if credentials accessed but key missing |
| `TELEGRAM_BOT_TOKEN` | (long string) | (none) | Only needed if Telegram gateway is active |
| `TELEGRAM_OPERATOR_CHAT_ID` | `12345` | (none) | Only needed if Telegram gateway is active |
| `PORT` | `9090` | `9090` | **Railway sets this automatically**; healthcheck probes this port |

### **Config Overrides** (optional, defaults provided)

```bash
# System behavior (app starts with these defaulted)
APP_SYSTEM_MODE=dry-run              # observe-only, dry-run, live, maintenance
APP_SYSTEM_LOGLEVEL=info             # trace, debug, info, warn, error, fatal

# Betting parameters
APP_BETTING_STAKEPERENTRY=700        # units per bet
APP_BETTING_CASHOUTARGET=1.30        # multiplier
APP_BETTING_MAXDAILYENTRIES=100      # hard cap

# Risk thresholds
APP_RISK_MINBALANCEFORENTRY=700      # circuit breaker
APP_RISK_MAXCONSECUTIVEERRORS=3      # stop after N errors
```

---

## Startup Sequence

```
1. docker-entrypoint.sh starts
   ├─ Wait for services (if WAIT_FOR_SERVICES set)
   ├─ Run migrations (if DATABASE_URL set AND SKIP_MIGRATIONS != true)
   │  └─ Connects to DB, runs migrations/*.sql in order
   │  └─ ❌ FAILS HERE if: DB unreachable, DB auth fails, migrations have SQL errors
   └─ Exec node dist/index.js

2. src/index.ts bootstrap()
   ├─ Load .env
   ├─ Hydrate secrets from Docker secret files (if *_FILE env vars set)
   ├─ Validate config (Zod schema)
   │  └─ ❌ FAILS HERE if: schema validation error (see errors in logs)
   ├─ Initialize event bus
   ├─ Connect to database
   │  └─ ❌ FAILS HERE if: DATABASE_URL missing, DB unreachable, DB auth fails
   ├─ Connect to Redis (if REDIS_URL set)
   │  └─ ❌ FAILS HERE if: REDIS_URL points to unreachable host, auth fails
   ├─ Start health monitor
   └─ Start HTTP server on PORT (default 9090)
      └─ Listens for /health, /metrics, /healthz endpoints
      └─ ✅ SUCCESS: now responds to healthchecks
```

---

## How to Get Runtime Logs

### **Railway Dashboard**

1. Go to your service → **Deployments** tab
2. Click on the failing deployment
3. Look for **"Deploy Logs"** vs **"Build Logs"** tabs:
   - **Build Logs** = docker build output (what you've been pasting)
   - **Deploy Logs** = runtime output from `node dist/index.js`
4. Paste the **Deploy Logs** (not Build Logs) here

### **Local Docker Testing**

```bash
# Build locally
docker build -t crash-test .

# Run with required env vars
docker run -it \
  -e DATABASE_URL="postgresql://localhost/crash" \
  -e REDIS_URL="redis://localhost" \
  -e TELEGRAM_BOT_TOKEN="fake" \
  -e TELEGRAM_OPERATOR_CHAT_ID="0" \
  crash-test

# Watch the startup sequence and any errors
```

### **Kubernetes/Railway Streaming**

```bash
# If you have CLI access to Railway
railway logs --service crash-automation --follow
```

---

## Diagnostic Checklist

Before pasting logs, verify these in Railway's service **Variables** tab:

```
DATABASE_URL
  ✅ Set?
  ✅ Contains protocol (postgresql://)?
  ✅ Contains username:password?
  ✅ Contains host:port?
  ✅ Contains database name?

REDIS_URL (optional)
  ✅ Not set at all? (OK, runs without Redis)
  ✅ Set AND reachable from Railway? (test: try connecting manually)

TENANT_MASTER_KEY (optional unless using encrypted creds)
  ✅ At least 32 characters?
  ✅ Not empty?

SKIP_MIGRATIONS (optional)
  ✅ If you want to skip migrations: set to "true" or "1"
  ✅ If running migrations: leave unset or set to "false"

WAIT_FOR_SERVICES (optional)
  ✅ If set (e.g., "db:5432 redis:6379"), make sure those hosts are reachable
```

---

## Common Failure Scenarios

### **Scenario 1: DATABASE_URL not set**

```
[entrypoint] starting crash-automation
[entrypoint] DATABASE_URL not set — skipping migrations
[entrypoint] launching app: node dist/index.js
Error: DATABASE_URL environment variable is required
    at bootstrap (/app/dist/src/index.js:...)
```

**Fix:** Set `DATABASE_URL` in Railway service Variables.

---

### **Scenario 2: Database unreachable**

```
[entrypoint] running database migrations...
Error: connect ECONNREFUSED 192.168.1.100:5432
    at Connector._forEach [as _getConnection] (node_modules/pg/lib/client.js:...)
```

**Fix:**
- Verify PostgreSQL is running and accessible from Railway network
- Check DATABASE_URL host/port
- Check network firewall / security groups allow Railway → DB connection

---

### **Scenario 3: Migrations fail**

```
[entrypoint] running database migrations...
✓ Applied migration 0001-schema.sql
✗ Migration 0002-indexes.sql failed: syntax error at or near "CREAT"
Error: migration failed
```

**Fix:**
- Check `migrations/*.sql` for syntax errors
- Review PostgreSQL version compatibility (need 15+)
- Run migrations locally first to validate

---

### **Scenario 4: Redis unreachable**

```
[app] Bootstrap
    at bootstrap (/app/dist/src/index.js:42)
Error: Redis health check failed
Error: connect ECONNREFUSED redis:6379
```

**Fix (either):**
- Remove `REDIS_URL` from Railway Variables (app runs without Redis)
- OR verify Redis is running and accessible from Railway network

---

### **Scenario 5: Config validation fails**

```
Configuration validation failed:
  betting.stakePerEntry: Number must be greater than 0
  system.mode: Invalid enum value (got "LIVE", expected "live")
```

**Fix:**
- Review APP_* env vars for typos or invalid values
- Boolean should be "true"/"false" (lowercase)
- Mode should be one of: observe-only, dry-run, live, maintenance (lowercase)

---

## Health Endpoint Details

Once the app starts successfully, it responds to:

```bash
# Health status
curl http://localhost:9090/health
# Response: { "status": "ok", "mode": "dry-run" }

# Prometheus metrics
curl http://localhost:9090/metrics
# Response: text/plain Prometheus format

# Health alias (Kubernetes)
curl http://localhost:9090/healthz
# Response: same as /health
```

If the container is running but healthcheck still fails:
- Check Railway's networking config (does it allow port 9090?)
- Verify the healthcheck command is probing the right port (should be `PORT` env var)
- Check if there's a proxy/load balancer between Railway and the container

---

## Next Steps

1. **Get the Deploy Logs from Railway** (not Build Logs)
2. **Paste them here** with the error message
3. **Match the error to the scenarios above**
4. **Apply the fix and redeploy**

If logs show the app is stuck (not crashing), the issue is likely:
- Database query hanging (migration or health check)
- Network timeout on external service connection
- Redis/database taking too long to respond

In that case, add timeouts:
```env
# Timeout database queries (milliseconds)
APP_HEALTH_CHECKINTERVALMS=5000

# Skip migrations to speed up startup
SKIP_MIGRATIONS=true
```

Then restart and provide new logs.
