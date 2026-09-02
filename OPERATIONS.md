# Operations Runbook — Personal-Use BC.Game Crash Automation

**Status:** Personal use, single operator.
**Source-of-truth:** `docs/runbooks.md` is the comprehensive document;
this file is the daily/weekly/monthly checklist.

## Daily

**Morning:**
- [ ] `curl http://localhost:9090/health` returns `200 OK` with `status: healthy`.
- [ ] Open Telegram, message your bot: `/status` shows the expected mode (`dry-run` or `live`), session id, and uptime.
- [ ] `/health` returns all green.
- [ ] `/analytics` shows signal stats from the last 24h.

**Throughout the day:**
- [ ] `/balance` and `/pnl` to see how the virtual ledger is doing (dry-run) or how live bets are tracking (live).
- [ ] If something looks off, `/pause` to halt betting (observation continues), then investigate via `/status` and `/health`.

**End of day:**
- [ ] `/analytics` to review the day's signal quality.
- [ ] Wait for the daily report (sent automatically every 24h; spec §5.2). If you want to read it now, ask the bot for `/pnl` + `/daily`.

## Weekly

- [ ] Review `/analytics` trend. Is the realized EV positive? If not, the strategy is losing; `/mode dry-run` and review your config.
- [ ] Check `npm audit` output for high/critical vulnerabilities in deps.
- [ ] `pg_dump $DATABASE_URL > /backup/crash-$(date +%F).sql` to back up the Postgres volume.
- [ ] `tar czf /backup/secrets-$(date +%F).tgz secrets/` (only after a successful `/login`).
- [ ] `git pull && npm ci && npm run build && docker compose up -d --build` to pick up upstream changes (if you're tracking the repo).

## Monthly

- [ ] Rotate `ENCRYPTION_KEY` if you have any reason to suspect compromise (rare; the key is only used to encrypt the BC.Game session cookie, not anything else).
- [ ] Update Playwright: `npx playwright install chromium`.
- [ ] Review the migration log: `psql $DATABASE_URL -c "SELECT * FROM audit_events ORDER BY occurred_at DESC LIMIT 100"`.
- [ ] Verify `secrets/` permissions: `ls -ld secrets/` should show `drwx------`.

## Stopping

- **Soft stop:** `/stop` — orchestrator stops cleanly, session marked ended.
- **Emergency stop:** `/emergencystop` — SheathMode forced, all bets canceled, manual intervention required to recover (`/resume`).
- **Process stop:** `Ctrl+C` in the terminal, or `docker compose stop app`, or `systemctl stop personal-bc-automation`.

## Backup

- `secrets/` (browser profile + encrypted session) — back up after a successful `/login`. Don't auto-back up; a leaked secrets bundle is worse than a re-login.
- Postgres data volume — back up weekly via `pg_dump` (or a Docker volume snapshot).
- `config.yaml` — back up if you've tuned it; otherwise the defaults are fine.

## Upgrade

```bash
git pull
npm ci
npm run db:migrate
npm run build
# restart via your process manager
```

Always read the changelog before upgrading; the API surface (Telegram commands) is stable, but config schema may add new optional fields.

## Going Live (transition from dry-run to live)

1. Run in `dry-run` for at least 24 hours. Verify `/health` shows all green.
2. Verify `/analytics` shows positive expected value (EV > 0 on the chosen target).
3. Verify `/pnl` is positive (or at least non-diverging).
4. Verify drawdown is below your risk threshold (`/daily`).
5. Run `npm audit` — no high/critical vulnerabilities.
6. Back up the `secrets/` directory.
7. Test `/emergencystop` once. Confirm the bot actually halts.
8. Test `/sheath` and `/unsheath`. Confirm the cycle works.
9. Test `/config set stakePerEntry 100` → confirm token → `/config confirm`.
10. Then and only then: `/mode live` → confirm token.

If `/login` has not been completed, the bot will reply with a clear error and refuse to enter live mode. Browser-based login requires the `src/browser/` module tree, which is currently a documented stub in this build.

## Recovery

**Process crash with live bet pending:**
- `RecoveryManager.runRecovery()` reconciles UNKNOWN bets on next boot.
- Check the log: `journalctl -u personal-bc-automation -n 200` or `docker compose logs --tail=200 app`.

**Telegram 409 (stale poller):**
- The 409 retry loop in `TelegramGateway.launchPolling()` handles this automatically (5 attempts, exponential backoff up to 30s).
- If it persists, restart the bot: `docker compose restart app`.

**DB transient error:**
- `pg` pool retries automatically. Check `/health` and `/metrics` (pg pool stats).

**Browser detached (live mode):**
- `BrowserManager` has a 5-attempt recovery loop. `/health` will show the issue. If it persists, `/login` again.
