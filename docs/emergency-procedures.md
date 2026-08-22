# Emergency Procedures

## Emergency Stop

### When to Trigger
- Unexpected balance drop > 20%
- Suspicious game behavior (impossible crash points)
- System errors preventing safe operation
- Operator uncertainty about continuing
- Any situation that feels unsafe

### How to Trigger
**Fastest method:** Telegram
```
/emergency-stop
```

**Alternative:** If Telegram is unavailable, restart the app container:
```bash
docker-compose restart app
```

### What Happens
1. All executors halt immediately
2. Pending bets are cancelled (marked FAILED)
3. System state is preserved
4. Operator receives confirmation via Telegram
5. System enters halted state

### Recovery
1. **Review the situation**
   - Check logs for errors
   - Review recent bets and rounds
   - Verify balance

2. **Resolve any UNKNOWN bets**
   ```bash
   ./scripts/restore-db.sh --verify-only <latest-backup>
   ```

3. **Reset emergency stop**
   ```
   /emergency-reset
   ```

4. **Resume operation**
   ```
   /resume
   ```

## Database Corruption

### Detection
- Database errors in logs
- Failed queries
- Data inconsistency alerts

### Immediate Actions
1. Stop the application
   ```bash
   docker-compose stop app
   ```

2. Assess corruption scope
   ```bash
   docker-compose exec postgres psql -U crash_user -d crash_automation -c "SELECT pg_database.datname, pg_database_size(pg_database.datname) FROM pg_database WHERE datname = 'crash_automation';"
   ```

3. Restore from backup
   ```bash
   ./scripts/restore-db.sh --drop-db <latest-backup-file>
   ```

4. Run recovery
   ```bash
   docker-compose exec app npm run recovery
   ```

5. Restart application
   ```bash
   docker-compose up -d app
   ```

## Browser Compromise

### Detection
- Browser process consuming excessive memory
- Browser frozen or unresponsive
- Unexpected popups or redirects

### Actions
1. The SessionSupervisor will attempt automatic recovery
2. If recovery fails after 3 attempts, the system stops
3. Manual restart:
   ```bash
   docker-compose restart app
   ```

## Network Partition

### Detection
- High tick latency
- Bet placement timeouts
- "Connection refused" errors

### Actions
1. System automatically halts betting
2. Check network connectivity:
   ```bash
   docker-compose exec app ping -c 4 bc.game
   ```
3. Wait for network recovery
4. System resumes automatically when latency normalizes

## Unknown Bets After Crash

### Detection
- RecoveryManager reports UNKNOWN bets on startup
- Telegram alert about unresolved bets

### Actions
1. List unknown bets
   ```bash
   docker-compose exec postgres psql -U crash_user -d crash_automation -c "SELECT id, round_id, stake, cash_out_target FROM bets WHERE state = 'UNKNOWN';"
   ```

2. Check round history
   ```bash
   docker-compose exec postgres psql -U crash_user -d crash_automation -c "SELECT external_round_id, observed_crash_point FROM rounds WHERE external_round_id IN (SELECT round_id FROM bets WHERE state = 'UNKNOWN');"
   ```

3. Resolve via Telegram
   ```
   /resolve-bet <bet-id> <state> <pnl>
   ```

## Contact Information

- Primary Operator: [Configured in Telegram]
- Secondary Operator: [Configured in Telegram]
- Dev Team: [Slack/Email]
- On-Call: [PagerDuty/Opsgenie]
