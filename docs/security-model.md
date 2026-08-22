# Security Model

## Threat Model

### Assets
1. Betting capital (real money)
2. Database (bet history, session data)
3. Browser profiles (authentication state)
4. Configuration (stakes, targets, credentials)
5. Audit trail (compliance evidence)

### Threats
1. **Unauthorized betting** - Attacker gains control of system
2. **Data exfiltration** - Sensitive data leaked
3. **Configuration tampering** - Stakes/targets modified
4. **Log tampering** - Audit trail corrupted
5. **Browser session hijacking** - Authentication stolen

## Controls

### Authentication & Authorization
- **Telegram Allowlist** - Only configured Telegram user IDs can issue commands
- **No Remote API** - No external API exposed; all control via Telegram
- **Dry-Run Gate** - Live mode requires explicit operator confirmation
- **Config Validation** - All configuration changes validated before application

### Data Protection
- **Encrypted Profiles** - Browser profiles encrypted at rest
- **Database Encryption** - PostgreSQL with SSL/TLS
- **No Secrets in Logs** - Sensitive data redacted from logs
- **Secure Backup** - Backups encrypted with AES-256

### Operational Security
- **Emergency Stop** - Immediate halt capability
- **Audit Trail** - Immutable event log
- **Least Privilege** - Database user has minimal permissions
- **Network Isolation** - Containers isolated via Docker networks

### Monitoring
- **Security Audit Script** - Weekly automated audit
- **Alert on Anomalies** - Unusual betting patterns trigger alerts
- **Log Integrity** - Log rotation with integrity checks

## Secrets Management

### Environment Variables
All secrets stored in `.env` file with 600 permissions:
```bash
chmod 600 .env
```

Required secrets:
- `DB_PASSWORD` - PostgreSQL password
- `REDIS_PASSWORD` - Redis password (if used)
- `TELEGRAM_BOT_TOKEN` - Bot API token
- `ENCRYPTION_KEY` - Backup/profile encryption key

### Docker Secrets (Production)
In production, use Docker secrets:
```yaml
secrets:
  db_password:
    file: ./secrets/db_password.txt
  telegram_token:
    file: ./secrets/telegram_token.txt
```

## Incident Response

### Detection
- Security audit script runs weekly
- Anomaly detection on betting patterns
- Log monitoring for suspicious activity

### Response
1. Trigger emergency stop
2. Preserve all logs and state
3. Run security audit
4. Review Telegram command history
5. Check for unauthorized config changes

### Recovery
1. Rotate all credentials
2. Restore from known-good backup
3. Re-verify all configurations
4. Gradual restart in observe-only mode
