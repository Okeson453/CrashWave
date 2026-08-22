# Runbooks

Complete operational runbooks for the BC.Game Crash Automation system. Each runbook is designed to be followed by a second operator without developer assistance.

## Table of Contents

1. [System Startup](#system-startup)
2. [System Shutdown](#system-shutdown)
3. [Mode Transition](#mode-transition)
4. [Emergency Stop](#emergency-stop)
5. [Browser Crash Recovery](#browser-crash-recovery)
6. [Database Recovery](#database-recovery)
7. [Unknown Bet Reconciliation](#unknown-bet-reconciliation)
8. [Daily Limit Reached](#daily-limit-reached)
9. [Latency Degradation](#latency-degradation)
10. [Telegram Bot Issues](#telegram-bot-issues)

---

## System Startup

### Prerequisites
- Docker Compose is installed
- `.env` file is configured with valid credentials
- Database migrations have been applied
- Telegram bot token is valid

### Steps
1. **Verify configuration**
   ```bash
   npm run config:validate
   ```

2. **Start infrastructure**
   ```bash
   docker-compose up -d postgres redis
   ```

3. **Wait for database readiness**
   ```bash
   docker-compose exec postgres pg_isready -U crash_user
   ```

4. **Apply migrations**
   ```bash
   npm run db:migrate
   ```

5. **Start the application**
   ```bash
   docker-compose up -d app
   ```

6. **Verify health**
   ```bash
   docker-compose logs -f app | grep "Orchestrator started"
   ```

7. **Check Telegram bot**
   Send `/status` to the bot. Should respond with system status.

### Verification
- Grafana dashboard "System Health" shows all components green
- Telegram bot responds to `/status`
- No CriticalError events in logs

---

## System Shutdown

### Graceful Shutdown
1. **Pause betting (if in live mode)**
   ```bash
   # Via Telegram
   /pause
   ```

2. **Stop the application**
   ```bash
   docker-compose stop app
   ```

3. **Verify no active bets**
   ```bash
   docker-compose exec postgres psql -U crash_user -d crash_automation -c "SELECT COUNT(*) FROM bets WHERE state IN ('PENDING', 'ACTIVE');"
   ```
   Result should be 0.

4. **Backup database**
   ```bash
   ./scripts/backup-db.sh
   ```

5. **Stop infrastructure**
   ```bash
   docker-compose down
   ```

### Emergency Shutdown
If graceful shutdown is not possible:
```bash
docker-compose down -t 30
```
This sends SIGTERM and waits 30 seconds before SIGKILL.

---

## Mode Transition

### Observe-Only to Dry-Run
1. Ensure system has been observing for at least 30 rounds
2. Verify no errors in the last 10 minutes
3. Send command via Telegram:
   ```
   /mode dry-run
   ```
4. Confirm the transition in logs:
   ```bash
   docker-compose logs app | grep "mode transition"
   ```

### Dry-Run to Live
1. Complete dry-run validation (100+ entries, zero unknown states)
2. Verify balance is sufficient
3. Send command via Telegram:
   ```
   /mode live
   ```
4. **Operator must explicitly confirm** the live mode transition
5. Monitor first 5 live bets closely

### Live to Observe-Only
1. Send command via Telegram:
   ```
   /mode observe-only
   ```
2. Wait for current round to complete
3. Verify no new bets are placed

---

## Emergency Stop

### When to Use
- Unexpected balance drop
- Suspicious game behavior
- Operator uncertainty
- Any situation where continuing feels unsafe

### Steps
1. **Trigger emergency stop**
   ```bash
   # Via Telegram (fastest)
   /emergency-stop
   ```
   Or via CLI:
   ```bash
   docker-compose exec app node -e "require('./src/core/emergency-stop').trigger('Manual emergency stop')"
   ```

2. **Verify stop**
   - Check Telegram for confirmation
   - Check logs for `EmergencyStop triggered`
   - Verify no active bets: `SELECT * FROM bets WHERE state = 'ACTIVE';`

3. **Assess situation**
   - Review recent rounds and bets
   - Check balance
   - Review error logs

4. **Reset when safe**
   ```
   /emergency-reset
   ```
   **Only after** reviewing all unknown bets and confirming system health.

---

## Browser Crash Recovery

### Detection
Symptoms:
- `Browser appears frozen` in logs
- `crash_automation_browser_up == 0` in Prometheus
- No new rounds observed for >30 seconds

### Steps
1. **Check browser health**
   ```bash
   docker-compose logs app | grep -i "browser\|frozen\|crash"
   ```

2. **SessionSupervisor will attempt automatic recovery**
   - Up to 3 recovery attempts
   - Each attempt reloads the page and reinitializes observation

3. **If automatic recovery fails**
   ```bash
   # Restart the app container
   docker-compose restart app
   ```

4. **Verify recovery**
   - Check Grafana for browser_up = 1
   - Check that rounds are being observed again
   - Review any UNKNOWN bets created during crash

---

## Database Recovery

### Database Unreachable
1. **Check database container**
   ```bash
   docker-compose ps postgres
   docker-compose logs postgres
   ```

2. **Restart database if needed**
   ```bash
   docker-compose restart postgres
   ```

3. **Verify connectivity**
   ```bash
   docker-compose exec postgres pg_isready -U crash_user
   ```

4. **If database is corrupt**
   ```bash
   # Restore from latest backup
   ./scripts/restore-db.sh --drop-db backups/crash_automation_YYYYMMDD_HHMMSS.sql.gz
   ```

### Data Corruption
1. **Stop the application**
   ```bash
   docker-compose stop app
   ```

2. **Identify corruption scope**
   ```bash
   docker-compose exec postgres psql -U crash_user -d crash_automation -c "SELECT pg_database.datname, pg_database_size(pg_database.datname) FROM pg_database WHERE datname = 'crash_automation';"
   ```

3. **Restore from backup**
   ```bash
   ./scripts/restore-db.sh --drop-db <latest-backup-file>
   ```

4. **Run recovery manager**
   ```bash
   docker-compose exec app npm run recovery
   ```

---

## Unknown Bet Reconciliation

### Detection
- RecoveryManager reports UNKNOWN bets on startup
- Telegram alert: "X bet(s) remain UNKNOWN after recovery sweep"
- Grafana shows `crash_automation_unknown_bets > 0`

### Automatic Resolution
The system attempts automatic resolution on startup:
1. Queries round history for each UNKNOWN bet
2. If crash point < target → marks LOST
3. If crash point >= target → marks RECONCILED

### Manual Resolution
If automatic resolution fails:

1. **List unknown bets**
   ```bash
   docker-compose exec postgres psql -U crash_user -d crash_automation -c "SELECT id, round_id, stake, cash_out_target, state FROM bets WHERE state = 'UNKNOWN';"
   ```

2. **Check round history**
   ```bash
   docker-compose exec postgres psql -U crash_user -d crash_automation -c "SELECT external_round_id, observed_crash_point, final_confirmed_crash_point FROM rounds WHERE external_round_id IN (SELECT round_id FROM bets WHERE state = 'UNKNOWN');"
   ```

3. **Resolve manually via Telegram**
   ```
   /resolve-bet <bet-id> <state> <pnl>
   ```
   Example:
   ```
   /resolve-bet bet-123 LOST -700
   ```

4. **Verify resolution**
   ```bash
   docker-compose exec postgres psql -U crash_user -d crash_automation -c "SELECT id, state, pnl FROM bets WHERE id = 'bet-123';"
   ```

---

## Daily Limit Reached

### Detection
- Telegram notification: "Daily entry limit reached (100/100)"
- Grafana shows daily entry utilization at 100%
- New bets are rejected with "Daily limit reached"

### Steps
1. **Verify limit status**
   ```bash
   # Via Telegram
   /status
   ```

2. **Wait for next day**
   The limit resets automatically at 00:00 UTC.

3. **If limit was reached prematurely**
   - Review betting log for duplicate entries
   - Check if dry-run bets were incorrectly counted
   - Verify the daily key is correct (YYYY-MM-DD)

4. **Emergency override (not recommended)**
   ```bash
   # Only if operator is certain the limit is incorrect
   docker-compose exec app node -e "require('./src/ledger/daily-entries').resetDailyEntries('YYYY-MM-DD')"
   ```

---

## Latency Degradation

### Detection
- Grafana shows P99 tick latency > 1000ms
- Telegram warning: "Tick latency p99 Xms exceeds critical threshold"
- Bets are being skipped due to high latency

### Steps
1. **Check system resources**
   ```bash
   docker stats
   ```

2. **Check browser health**
   ```bash
   docker-compose logs app | grep -i "latency\|frozen\|memory"
   ```

3. **Check network connectivity**
   ```bash
   docker-compose exec app ping -c 4 bc.game
   ```

4. **If browser is consuming too much memory**
   ```bash
   docker-compose restart app
   ```

5. **If network is slow**
   - Check ISP connection
   - Consider using a different network
   - Enable VPN if configured

6. **Monitor recovery**
   Watch Grafana for latency to return below 500ms.

---

## Telegram Bot Issues

### Bot Not Responding
1. **Check bot token**
   ```bash
   grep TELEGRAM_BOT_TOKEN .env
   ```

2. **Verify bot is running**
   ```bash
   docker-compose logs app | grep -i "telegram\|bot"
   ```

3. **Check Telegram API status**
   Visit https://status.telegram.org/

4. **Restart app if needed**
   ```bash
   docker-compose restart app
   ```

### Bot Responding But Commands Fail
1. **Check operator allowlist**
   ```bash
   grep allowedUserIds config/telegram.yml
   ```
   Ensure your Telegram user ID is in the list.

2. **Check bot permissions**
   - Bot must have permission to send messages
   - Chat ID must be correct

3. **Test with simple command**
   ```
   /ping
   ```
   Should respond with "pong".
