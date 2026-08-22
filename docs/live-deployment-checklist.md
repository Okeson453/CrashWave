# Live Deployment Checklist

Use this checklist before deploying to live production environment.

## Pre-Deployment

- [ ] All tests pass (`npm test`)
- [ ] Test coverage > 80% on critical paths
- [ ] Dry-run validation complete (100+ entries, zero unknown states)
- [ ] Security audit passed (`./scripts/security-audit.sh`)
- [ ] Performance benchmark passed (`./scripts/performance-benchmark.sh`)
- [ ] Configuration validated (`npm run config:validate`)
- [ ] Database migrations applied
- [ ] Backup script tested
- [ ] Restore script tested
- [ ] Telegram bot token valid
- [ ] Operator Telegram ID in allowlist

## Infrastructure

- [ ] Docker Compose file reviewed
- [ ] PostgreSQL container configured with persistent volume
- [ ] Redis container configured with persistent volume
- [ ] Grafana dashboards imported
- [ ] Prometheus alert rules loaded
- [ ] Log rotation configured (cron)
- [ ] Backup cron job configured
- [ ] S3 credentials configured (if using remote backup)

## Security

- [ ] `.env` file has restricted permissions (600)
- [ ] No secrets in repository
- [ ] Profile directory encrypted
- [ ] Database password strong
- [ ] Redis password configured (if exposed)
- [ ] Firewall rules configured
- [ ] SSL/TLS for all external connections

## Monitoring

- [ ] Grafana accessible
- [ ] Prometheus scraping targets healthy
- [ ] Alertmanager configured
- [ ] Telegram alerts tested
- [ ] Email alerts configured (optional)
- [ ] PagerDuty/Opsgenie integration (optional)

## Betting Configuration

- [ ] Stake amount verified
- [ ] Cash-out target verified
- [ ] Max daily entries set (default: 100)
- [ ] Min balance threshold set
- [ ] Max drawdown threshold set
- [ ] Consecutive loss threshold set
- [ ] Day boundary timezone configured

## Operator Readiness

- [ ] Operator trained on Telegram commands
- [ ] Operator has access to runbooks
- [ ] Operator knows emergency procedures
- [ ] Operator knows how to trigger emergency stop
- [ ] Operator knows how to resolve unknown bets
- [ ] Secondary operator identified

## Go-Live Sequence

1. [ ] Deploy to observe-only mode
2. [ ] Verify observation for 30+ rounds
3. [ ] Verify tick latency < 500ms P99
4. [ ] Transition to dry-run mode
5. [ ] Run 100+ dry-run entries
6. [ ] Verify zero unknown states
7. [ ] Verify balance reconciliation
8. [ ] Operator explicitly approves live mode
9. [ ] Transition to live mode
10. [ ] Monitor first 5 live bets closely
11. [ ] Verify Telegram notifications
12. [ ] Verify Grafana metrics

## Post-Deployment

- [ ] First day P&L reviewed
- [ ] All alerts functioning
- [ ] Backup completed successfully
- [ ] Log rotation working
- [ ] No critical errors in first 24h
- [ ] Operator sign-off obtained


## Detection & Anti-Bot (mandatory review before live)

- [ ] **Residential / ISP proxy** configured (`APP_PROXY__ENABLED=true`) with sticky session
- [ ] Proxy geo matches fingerprint timezone/locale
- [ ] Confirmed exit IP is not datacenter (check via provider dashboard)
- [ ] `preferNonHeadlessForLive` left true — live runs **headed**
- [ ] Advanced stealth v2 enabled
- [ ] Velocity limits appropriate for stake frequency (not maxed out)
- [ ] Humanizer / HumanInput enabled for placement and cash-out
- [ ] Telemetry noise left **disabled** unless deterministic patterns are being flagged
- [ ] Account-link baseline: one profile directory + one sticky proxy per process

## Auth & Session

- [ ] Browser profile restored and authenticated in observe-only
- [ ] Operator knows `/reauth_complete` procedure after auth loss
- [ ] Session age threshold understood (`sessionConsistency.maxSessionAgeHours`)
- [ ] No automated password login (by design) — operator handles re-login in headed UI

## Soak & Evidence

- [ ] Observe-only soak ≥ 2 hours completed (`npx tsx scripts/soak-observe.ts --hours 2`)
- [ ] RSS growth and event-loop lag within soft thresholds
- [ ] Single-instance lock verified (`REDIS_URL=... npx tsx scripts/verify-single-instance.ts`)
- [ ] Redis dual-client mutex test run when Redis available

## Capital & Risk (live money)

- [ ] Maximum loss amount defined and funded account ≤ that amount
- [ ] Daily entry hard cap set below psychological comfort level
- [ ] Multi-step live confirmation tokens tested end-to-end
- [ ] Emergency stop Telegram command tested
- [ ] Operator present for first 20+ live rounds
- [ ] Rollback plan: switch mode to `observe-only` or `maintenance` immediately

## Final sign-off

- [ ] Technical lead signs: no Critical gaps remaining
- [ ] Operator signs: trained on re-auth, emergency stop, UNKNOWN resolution
- [ ] Date/time of controlled go-live recorded in `docs/GAP_CLOSURE_LOG.md`
